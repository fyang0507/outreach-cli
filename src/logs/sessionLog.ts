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

// Per-process cache for contact name lookups during hydration.
// A single CLI invocation typically writes a handful of events for the same
// contact (attempt + watch, question + watch, etc.); caching avoids re-reading
// the same contact JSON for each append.
const contactNameCache = new Map<string, string | null>();

async function lookupContactName(contactId: string): Promise<string | null> {
  if (contactNameCache.has(contactId)) return contactNameCache.get(contactId)!;
  try {
    const contact = await readContact(contactId);
    const name = contact.name ?? null;
    contactNameCache.set(contactId, name);
    return name;
  } catch {
    // Contact not found or unreadable — skip hydration silently. Adhoc flows
    // and campaign-level events (contact_id: null) land here and are fine.
    contactNameCache.set(contactId, null);
    return null;
  }
}

// If the event references a contact_id, attach the contact's name so that
// downstream consumers (relay → Telegram) can show a human-readable label
// next to the opaque id. No-op when contact_id is absent/null or the contact
// has no name on file.
async function hydrateContactName(event: object): Promise<object> {
  const e = event as Record<string, unknown>;
  if (typeof e.contact_id !== "string" || e.contact_id.length === 0) return event;
  if ("contact_name" in e) return event;
  const name = await lookupContactName(e.contact_id);
  if (!name) return event;
  return { ...e, contact_name: name };
}

// Thrown when a campaign-scoped append targets a file that doesn't exist or
// doesn't begin with a `campaign_header` for the matching campaign_id. Lets
// callers distinguish this validation failure from other I/O errors so they
// can surface a clean INPUT_ERROR instead of leaking a stack trace.
export class CampaignHeaderError extends Error {
  readonly code = "CAMPAIGN_HEADER_MISSING";
  readonly campaignId: string;
  constructor(campaignId: string, reason: string) {
    super(reason);
    this.name = "CampaignHeaderError";
    this.campaignId = campaignId;
  }
}

// Verify the campaign JSONL exists and starts with a valid `campaign_header`
// for `campaignId`. Protects the invariant that every campaign file begins
// with a header — without it, audit/event appends could silently create a
// headerless JSONL that looks like a campaign but isn't.
export async function assertCampaignHeader(campaignId: string): Promise<void> {
  const { campaignsDir } = await getDataDirs();
  const filePath = join(campaignsDir, `${campaignId}.jsonl`);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CampaignHeaderError(
        campaignId,
        `Campaign file ${filePath} does not exist. Write a campaign_header line first (see skills/outreach/campaign.md § Campaigns) before running any campaign-scoped command for '${campaignId}'.`,
      );
    }
    throw err;
  }
  const firstLine = content.split("\n", 1)[0] ?? "";
  if (firstLine.length === 0) {
    throw new CampaignHeaderError(
      campaignId,
      `Campaign file ${filePath} is empty. The first line must be a campaign_header for '${campaignId}'.`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    throw new CampaignHeaderError(
      campaignId,
      `Campaign file ${filePath} first line is not valid JSON. The first line must be a campaign_header for '${campaignId}'.`,
    );
  }
  // Backward-compat: older campaign headers were authored without an explicit
  // `type` field — they're identified by carrying `campaign_id` + `objective`
  // and lacking the `ts` that every audit/event row has. Accept both forms;
  // reject only when `type` is set to anything other than `campaign_header`
  // (i.e. the first line is an audit/event row, not a header).
  const hasType = "type" in parsed;
  if (hasType && parsed.type !== "campaign_header") {
    throw new CampaignHeaderError(
      campaignId,
      `Campaign file ${filePath} first line has type=${JSON.stringify(parsed.type)}, expected 'campaign_header'. The first line of every campaign JSONL must be a campaign_header.`,
    );
  }
  if (parsed.campaign_id !== campaignId) {
    throw new CampaignHeaderError(
      campaignId,
      `Campaign header campaign_id=${JSON.stringify(parsed.campaign_id)} in ${filePath} does not match requested campaign_id='${campaignId}'.`,
    );
  }
}

export async function appendCampaignEvent(
  campaignId: string,
  event: object,
): Promise<void> {
  const { campaignsDir } = await getDataDirs();
  await mkdir(campaignsDir, { recursive: true });
  await assertCampaignHeader(campaignId);
  const filePath = join(campaignsDir, `${campaignId}.jsonl`);
  const hydrated = await hydrateContactName(event);
  await appendFile(filePath, JSON.stringify(hydrated) + "\n", "utf-8");
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
