import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadAppConfig } from "../appConfig.js";

export function isoNow(): string {
  return new Date().toISOString();
}

interface BaseEvent {
  type: string;
  ts: string;
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

export interface MediaStreamStartedEvent extends BaseEvent {
  type: "media_stream_started";
  stream_sid: string;
  call_sid?: string;
}

export interface FirstOutboundAudioEvent extends BaseEvent {
  type: "first_outbound_audio";
}

export interface FirstOutboundAudioPlayedEvent extends BaseEvent {
  type: "first_outbound_audio_played";
}

export interface InitialGreetingRequestedEvent extends BaseEvent {
  type: "initial_greeting_requested";
}

export interface OutboundTurnGeneratedEvent extends BaseEvent {
  type: "outbound_turn_generated";
  turn_id: string;
  reason: string;
}

export interface OutboundTurnPlayedEvent extends BaseEvent {
  type: "outbound_turn_played";
  turn_id: string;
}

export interface EndCallRequestedEvent extends BaseEvent {
  type: "end_call_requested";
  reason: string;
  source: string;
}

export interface DeferredHangupEvent extends BaseEvent {
  type: "deferred_hangup";
  reason: string;
  source: string;
  pending_turn_id?: string;
}

export interface HangupTimeoutEvent extends BaseEvent {
  type: "hangup_timeout";
  reason: string;
}

export interface RemoteActivityStartEvent extends BaseEvent {
  type: "remote_activity_start";
}

export interface RemoteActivityEndEvent extends BaseEvent {
  type: "remote_activity_end";
}

export interface AudioClearedEvent extends BaseEvent {
  type: "audio_cleared";
  reason: string;
  turn_id?: string;
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
  wait_for_user_before_greeting?: boolean;
  experimental_local_vad?: boolean;
  twilio_call_create_ms?: number;
  gemini_preconnected_before_call?: boolean;
  gemini_preconnect_ms?: number;
  pre_generated_greeting_requested?: boolean;
  pre_generated_greeting_audio_chunks?: number;
  pre_generated_greeting_ended_before_stream?: boolean;
  pre_generated_greeting_ready_before_stream?: boolean;
  pre_generated_greeting_request_to_first_generated_audio_ms?: number;
  pre_generated_greeting_request_to_first_outbound_audio_ms?: number;
  answer_to_stream_ms?: number;
  stream_to_initial_greeting_request_ms?: number;
  initial_greeting_request_to_first_outbound_audio_ms?: number;
  stream_to_first_outbound_audio_ms?: number;
  answer_to_first_outbound_audio_ms?: number;
  stream_to_first_outbound_audio_played_ms?: number;
  answer_to_first_outbound_audio_played_ms?: number;
  first_remote_audio_activity_delay_ms?: number;
  first_remote_audio_activity_end_delay_ms?: number;
  first_remote_audio_activity_to_first_outbound_audio_ms?: number;
  first_remote_audio_activity_to_first_outbound_audio_played_ms?: number;
  first_remote_audio_activity_end_to_first_outbound_audio_ms?: number;
  first_remote_audio_activity_end_to_first_outbound_audio_played_ms?: number;
  last_remote_audio_activity_to_first_outbound_audio_ms?: number;
  last_remote_audio_activity_to_first_outbound_audio_played_ms?: number;
  first_remote_speech_delay_ms?: number;
  first_response_delay_ms?: number;
}

export type TranscriptEvent =
  | CallPlacedEvent
  | CallRingingEvent
  | CallAnsweredEvent
  | AmdResultEvent
  | MediaStreamStartedEvent
  | FirstOutboundAudioEvent
  | FirstOutboundAudioPlayedEvent
  | InitialGreetingRequestedEvent
  | OutboundTurnGeneratedEvent
  | OutboundTurnPlayedEvent
  | EndCallRequestedEvent
  | DeferredHangupEvent
  | HangupTimeoutEvent
  | RemoteActivityStartEvent
  | RemoteActivityEndEvent
  | AudioClearedEvent
  | SpeechEvent
  | DtmfEvent
  | CallEndedEvent
  | CallSummaryEvent;

async function transcriptsDir(): Promise<string> {
  const config = await loadAppConfig();
  return join(config.data_repo_path, "outreach", "transcripts");
}

export async function transcriptPath(callId: string): Promise<string> {
  return join(await transcriptsDir(), `${callId}.jsonl`);
}

export async function latestTranscriptCallId(): Promise<string | null> {
  const dir = await transcriptsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const transcriptFiles = entries.filter((entry) => /^call_[a-f0-9]+\.jsonl$/.test(entry));
  let latest: { file: string; mtimeMs: number } | undefined;
  for (const file of transcriptFiles) {
    const info = await stat(join(dir, file));
    if (!latest || info.mtimeMs > latest.mtimeMs) {
      latest = { file, mtimeMs: info.mtimeMs };
    }
  }

  return latest ? basename(latest.file, ".jsonl") : null;
}

export async function ensureDataDirs(): Promise<void> {
  await mkdir(await transcriptsDir(), { recursive: true });
}

export async function writeTranscript(
  callId: string,
  events: TranscriptEvent[],
): Promise<void> {
  const dir = await transcriptsDir();
  await mkdir(dir, { recursive: true });
  const data = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(await transcriptPath(callId), data, "utf-8");
}

export async function readTranscript(callId: string): Promise<TranscriptEvent[]> {
  const content = await readFile(await transcriptPath(callId), "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TranscriptEvent);
}
