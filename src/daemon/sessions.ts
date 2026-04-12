import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { TranscriptEvent, SpeechEvent } from "../logs/sessionLog.js";
import type { GeminiLiveSession } from "../audio/geminiLive.js";

export interface CallSession {
  id: string;
  callSid?: string;
  status: "ringing" | "in_progress" | "ended";
  from: string;
  to: string;
  startTime: number;
  transcriptBuffer: TranscriptEvent[];
  fullTranscript: TranscriptEvent[];
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
  campaignId?: string;  // Campaign ID for auto-logging attempts
  contactId?: string; // Contact ID for campaign attempt entry

  // Milestone timestamps (ISO 8601) for call lifecycle metrics
  callPlacedAt?: string;
  ringingAt?: string;
  answeredAt?: string;
  firstRemoteSpeechAt?: string;
  firstLocalResponseAt?: string;
  answeredBy?: string; // Twilio AMD result
}

const sessions = new Map<string, CallSession>();

export function appendEvent(
  session: CallSession,
  event: TranscriptEvent,
): void {
  session.transcriptBuffer.push(event);
  session.fullTranscript.push(event);

  // Update speech/activity tracking only for speech events
  if (event.type === "speech") {
    const speech = event as SpeechEvent;
    session.lastSpeechTime = Date.now();
    session.lastTranscriptTime = Date.now();

    // Track milestone: first remote speech after answer
    if (speech.speaker === "remote" && !session.firstRemoteSpeechAt) {
      session.firstRemoteSpeechAt = event.ts;
    }
    // Track milestone: first local response after remote speech
    if (speech.speaker === "local" && session.firstRemoteSpeechAt && !session.firstLocalResponseAt) {
      session.firstLocalResponseAt = event.ts;
    }
  }

  session.lastActivityTime = Date.now();
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
