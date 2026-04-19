import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAppConfig } from "../appConfig.js";
import type { Contact } from "../contacts.js";

// --- Timestamp helper ---

export function isoNow(): string {
  return new Date().toISOString();
}

// --- Transcript event types ---

interface BaseEvent {
  type: string;
  ts: string; // ISO 8601
}

export interface CallPlacedEvent extends BaseEvent {
  type: "call_placed";
  from: string;
  to: string;
}

export interface CallRingingEvent extends BaseEvent {
  type: "call_ringing";
  call_sid: string;
}

export interface CallAnsweredEvent extends BaseEvent {
  type: "call_answered";
  ring_duration_ms: number;
}

export interface AmdResultEvent extends BaseEvent {
  type: "amd_result";
  answered_by: string;
}

export interface SpeechEvent extends BaseEvent {
  type: "speech";
  speaker: "remote" | "local";
  text: string;
}

export interface DtmfEvent extends BaseEvent {
  type: "dtmf";
  digits: string;
}

export interface CallEndedEvent extends BaseEvent {
  type: "call_ended";
  reason: string;
  duration_ms: number;
}

export interface CallSummaryEvent extends BaseEvent {
  type: "call_summary";
  duration_ms: number;
  ring_duration_ms?: number;
  answered_by?: string;
  first_remote_speech_delay_ms?: number;
  first_response_delay_ms?: number;
}

export type TranscriptEvent =
  | CallPlacedEvent
  | CallRingingEvent
  | CallAnsweredEvent
  | AmdResultEvent
  | SpeechEvent
  | DtmfEvent
  | CallEndedEvent
  | CallSummaryEvent;

// --- Data directories ---

interface DataDirs {
  contactsDir: string;
  campaignsDir: string;
  transcriptsDir: string;
  callbackLogsDir: string;
}

let _dirs: DataDirs | null = null;

async function getDataDirs(): Promise<DataDirs> {
  if (_dirs) return _dirs;
  const config = await loadAppConfig();
  const outreachDir = join(config.data_repo_path, "outreach");
  _dirs = {
    contactsDir: join(outreachDir, "contacts"),
    campaignsDir: join(outreachDir, "campaigns"),
    transcriptsDir: join(outreachDir, "transcripts"),
    callbackLogsDir: join(outreachDir, "callback-logs"),
  };
  return _dirs;
}

export async function ensureDataDirs(): Promise<void> {
  const { contactsDir, campaignsDir, transcriptsDir } = await getDataDirs();
  await mkdir(contactsDir, { recursive: true });
  await mkdir(campaignsDir, { recursive: true });
  await mkdir(transcriptsDir, { recursive: true });
}

// Build the absolute log path for a callback-dispatch run and ensure the
// enclosing directory exists. Filename encodes (campaign, contact, channel,
// fsTsStamp) to keep runs trivially sortable and greppable.
export async function buildCallbackLogPath(opts: {
  campaignId: string;
  contactId: string;
  channel: string;
  fsTsStamp: string;
}): Promise<string> {
  const { callbackLogsDir } = await getDataDirs();
  await mkdir(callbackLogsDir, { recursive: true });
  const filename = `${opts.campaignId}-${opts.contactId}-${opts.channel}-${opts.fsTsStamp}.log`;
  return join(callbackLogsDir, filename);
}

export async function appendCampaignEvent(
  campaignId: string,
  event: object,
): Promise<void> {
  const { campaignsDir } = await getDataDirs();
  await mkdir(campaignsDir, { recursive: true });
  const filePath = join(campaignsDir, `${campaignId}.jsonl`);
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
}

export async function writeTranscript(
  callId: string,
  events: TranscriptEvent[],
): Promise<void> {
  const { transcriptsDir } = await getDataDirs();
  await mkdir(transcriptsDir, { recursive: true });
  const filePath = join(transcriptsDir, `${callId}.jsonl`);
  const data = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(filePath, data, "utf-8");
}

// --- Read helpers ---

function parseLine(line: string): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { raw: line };
  }
}

export async function readCampaignEvents(
  campaignId: string,
): Promise<{ header: Record<string, unknown>; events: Record<string, unknown>[] }> {
  const { campaignsDir } = await getDataDirs();
  const filePath = join(campaignsDir, `${campaignId}.jsonl`);
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  const header = lines.length > 0 ? parseLine(lines[0]!) : {};
  const events = lines.slice(1).map(parseLine);
  return { header, events };
}

// --- Outbound attempt lookup ---

export interface OutboundAttempt {
  ts: string;
  contact_id: string;
  channel: string;
  message_id?: string; // email only
  thread_id?: string; // email only
}

export async function findLatestOutboundAttempt(
  campaignId: string,
  contactId: string,
  channel: string,
): Promise<OutboundAttempt | null> {
  let data: { header: Record<string, unknown>; events: Record<string, unknown>[] };
  try {
    data = await readCampaignEvents(campaignId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  // Check all lines including header — campaign files created by direct send
  // may not have a separate header line, so the first event lands in `header`.
  const allLines = [data.header, ...data.events];

  // Iterate in reverse to find the latest matching sent attempt
  for (let i = allLines.length - 1; i >= 0; i--) {
    const e = allLines[i]!;
    if (
      e.type === "attempt" &&
      e.contact_id === contactId &&
      e.channel === channel &&
      e.result === "sent"
    ) {
      return {
        ts: e.ts as string,
        contact_id: e.contact_id as string,
        channel: e.channel as string,
        message_id: e.message_id as string | undefined,
        thread_id: e.thread_id as string | undefined,
      };
    }
  }

  return null;
}

// --- Human question lookup ---

export interface HumanQuestion {
  ts: string;
  campaign_id: string;
  contact_id?: string;
  question: string;
}

export async function findLatestHumanQuestion(
  campaignId: string,
  contactId?: string,
): Promise<HumanQuestion | null> {
  let data: { header: Record<string, unknown>; events: Record<string, unknown>[] };
  try {
    data = await readCampaignEvents(campaignId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const allLines = [data.header, ...data.events];

  for (let i = allLines.length - 1; i >= 0; i--) {
    const e = allLines[i]!;
    if (e.type !== "human_question") continue;
    if (contactId != null && e.contact_id !== contactId) continue;
    if (typeof e.ts !== "string" || typeof e.question !== "string") continue;
    return {
      ts: e.ts,
      campaign_id: campaignId,
      contact_id: typeof e.contact_id === "string" ? e.contact_id : undefined,
      question: e.question,
    };
  }

  return null;
}

export async function hasNewHumanInputSince(
  campaignId: string,
  baselineTs: string,
): Promise<boolean> {
  let data: { header: Record<string, unknown>; events: Record<string, unknown>[] };
  try {
    data = await readCampaignEvents(campaignId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  const allLines = [data.header, ...data.events];

  for (const e of allLines) {
    if (e.type !== "human_input") continue;
    // Relay-inbound entries use `timestamp` instead of `ts`; accept either.
    const raw = typeof e.ts === "string" ? e.ts : e.timestamp;
    if (typeof raw !== "string") continue;
    if (raw > baselineTs) return true;
  }

  return false;
}

// --- Callback run lookup ---

export interface CallbackRunResumeInfo {
  ts: string;
  agent: string;
  session_id: string;
}

// Find the latest callback_run event for (contactId, channel) that captured a
// session, so the next callback can --resume from it. Runs without a captured
// session (crash, parse failure, agent abort) are skipped — we keep walking
// backwards to find the last successful resume handle.
export async function findLatestCallbackRun(
  campaignId: string,
  contactId: string,
  channel: string,
): Promise<CallbackRunResumeInfo | null> {
  let data: { header: Record<string, unknown>; events: Record<string, unknown>[] };
  try {
    data = await readCampaignEvents(campaignId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const allLines = [data.header, ...data.events];

  for (let i = allLines.length - 1; i >= 0; i--) {
    const e = allLines[i]!;
    if (
      e.type === "callback_run" &&
      e.contact_id === contactId &&
      e.channel === channel &&
      e.session_captured === true &&
      typeof e.agent === "string" &&
      typeof e.new_session_id === "string"
    ) {
      return {
        ts: e.ts as string,
        agent: e.agent,
        session_id: e.new_session_id,
      };
    }
  }

  return null;
}

// Campaign-scoped variant for the ask-human channel. ask-human questions may
// be campaign-level (no contact_id), so the resume chain cannot filter by
// contact — any prior human_input callback on this campaign is fair game.
export async function findLatestHumanInputCallbackRun(
  campaignId: string,
): Promise<CallbackRunResumeInfo | null> {
  let data: { header: Record<string, unknown>; events: Record<string, unknown>[] };
  try {
    data = await readCampaignEvents(campaignId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const allLines = [data.header, ...data.events];

  for (let i = allLines.length - 1; i >= 0; i--) {
    const e = allLines[i]!;
    if (
      e.type === "callback_run" &&
      e.channel === "human_input" &&
      e.session_captured === true &&
      typeof e.agent === "string" &&
      typeof e.new_session_id === "string"
    ) {
      return {
        ts: e.ts as string,
        agent: e.agent,
        session_id: e.new_session_id,
      };
    }
  }

  return null;
}

export async function readContact(
  contactId: string,
): Promise<Contact> {
  const { contactsDir } = await getDataDirs();
  const filePath = join(contactsDir, `${contactId}.json`);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Contact '${contactId}' not found at ${filePath}. Check the contact ID or create the contact record.`);
    }
    throw err;
  }
  return JSON.parse(content) as Contact;
}
