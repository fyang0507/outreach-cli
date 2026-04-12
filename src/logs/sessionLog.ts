import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAppConfig } from "../appConfig.js";

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

let _dirs: { contactsDir: string; campaignsDir: string; transcriptsDir: string } | null = null;

async function getDataDirs(): Promise<{ contactsDir: string; campaignsDir: string; transcriptsDir: string }> {
  if (_dirs) return _dirs;
  const config = await loadAppConfig();
  const outreachDir = join(config.data_repo_path, "outreach");
  _dirs = {
    contactsDir: join(outreachDir, "contacts"),
    campaignsDir: join(outreachDir, "campaigns"),
    transcriptsDir: join(outreachDir, "transcripts"),
  };
  return _dirs;
}

export async function ensureDataDirs(): Promise<void> {
  const { contactsDir, campaignsDir, transcriptsDir } = await getDataDirs();
  await mkdir(contactsDir, { recursive: true });
  await mkdir(campaignsDir, { recursive: true });
  await mkdir(transcriptsDir, { recursive: true });
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

export async function readContact(
  contactId: string,
): Promise<Record<string, unknown>> {
  const { contactsDir } = await getDataDirs();
  const filePath = join(contactsDir, `${contactId}.json`);
  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}
