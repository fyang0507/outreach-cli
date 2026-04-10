import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { TranscriptEntry } from "../logs/sessionLog.js";
import type { GeminiLiveSession } from "../audio/geminiLive.js";

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
  lastTranscriptTime: number;
  maxDurationMs?: number;
  streamSid?: string;
  systemInstruction?: string;
  bridge?: unknown; // MediaStreamsBridge reference
  preConnectedGemini?: GeminiLiveSession; // Pre-connected Gemini session (issue #9)
  campaign?: string;  // Campaign ID for auto-logging attempts
  contactId?: string; // Contact ID for campaign attempt entry
}

const sessions = new Map<string, CallSession>();

export function appendTranscriptEntry(
  session: CallSession,
  entry: TranscriptEntry,
): void {
  session.transcriptBuffer.push(entry);
  session.fullTranscript.push(entry);
  session.lastSpeechTime = Date.now();
  session.lastActivityTime = Date.now();
  session.lastTranscriptTime = Date.now();
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
    lastTranscriptTime: now,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): CallSession | undefined {
  return sessions.get(id);
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

export function listSessions(): CallSession[] {
  return Array.from(sessions.values());
}
