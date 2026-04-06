import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { TranscriptEntry } from "../logs/sessionLog.js";

export interface CallSession {
  id: string;
  callSid?: string;
  status: "ringing" | "in_progress" | "ended";
  from: string;
  to: string;
  startTime: number;
  transcriptBuffer: TranscriptEntry[];
  fullTranscript: TranscriptEntry[];
  ws?: WebSocket;
  lastListenIndex: number;
  lastSpeechTime: number;
  lastActivityTime: number;
  streamSid?: string;
  systemInstruction?: string;
  bridge?: unknown; // MediaStreamsBridge reference
}

const sessions = new Map<string, CallSession>();

/** Emits "transcript:<callId>" when new transcript entries are appended */
export const sessionEvents = new EventEmitter();

export function appendTranscriptEntry(
  session: CallSession,
  entry: TranscriptEntry,
): void {
  session.transcriptBuffer.push(entry);
  session.fullTranscript.push(entry);
  session.lastSpeechTime = Date.now();
  session.lastActivityTime = Date.now();
  sessionEvents.emit(`transcript:${session.id}`);
}

export function generateCallId(): string {
  return "call_" + randomBytes(6).toString("hex");
}

export function createSession(params: {
  id?: string;
  from: string;
  to: string;
}): CallSession {
  const now = Date.now();
  const session: CallSession = {
    id: params.id ?? generateCallId(),
    status: "ringing",
    from: params.from,
    to: params.to,
    startTime: now,
    transcriptBuffer: [],
    fullTranscript: [],
    lastListenIndex: 0,
    lastSpeechTime: now,
    lastActivityTime: now,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): CallSession | undefined {
  return sessions.get(id);
}

export function getSessionByCallSid(callSid: string): CallSession | undefined {
  for (const session of sessions.values()) {
    if (session.callSid === callSid) return session;
  }
  return undefined;
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

export function listSessions(): CallSession[] {
  return Array.from(sessions.values());
}
