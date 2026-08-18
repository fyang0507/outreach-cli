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
  waitForUserBeforeGreeting?: boolean;
  streamSid?: string;
  systemInstruction?: string;
  bridge?: unknown; // MediaStreamsBridge reference
  preConnectedGemini?: GeminiLiveSession; // Pre-connected Gemini session (issue #9)
  preConnectingGemini?: Promise<GeminiLiveSession | null>;
  preconnectAbandoned?: boolean; // Handover was given up on; an in-flight preconnect must self-close
  preconnectHandover?: "warm" | "handover" | "fresh_fallback" | "none";
  preconnectHandoverWaitMs?: number;
  preGeneratedGreetingAudio: string[];
  preGeneratedGreetingAudioChunks: number;
  preGeneratedGreetingTranscriptParts: string[];
  // The greeting turn finished generating (a real generation/turn-complete signal),
  // which is what decides whether anything is still streaming at pickup. Distinct
  // from the socket closing below: a completed turn on a live session is the
  // normal case, a closed session is a pre-connect failure.
  preGeneratedGreetingTurnComplete: boolean;
  preGeneratedGreetingTurnCompleteAt?: string;
  // Set only when the remote end closed the pre-connect socket (a pre-connect
  // failure); our own close() never reports back. Read by the call summary.
  preGeneratedGreetingSessionClosedAt?: string;
  // A `send_dtmf` TwiML swap drops the media stream and opens a replacement for the
  // same call. Set while that gap is open so the bridge teardown does not end and
  // finalize a call that is still in progress.
  expectingStreamReconnect?: boolean;
  finalized: boolean; // Whether finalizeCall() has already run (idempotency guard)
  finalizedAt?: number; // Date.now() once the transcript write settled; gates reaping

  // Milestone timestamps (ISO 8601) for call lifecycle metrics
  callCreateStartedAt?: string;
  callPlacedAt?: string;
  geminiPreconnectStartedAt?: string;
  geminiPreconnectConnectedAt?: string;
  ringingAt?: string;
  answeredAt?: string;
  mediaStreamStartedAt?: string;
  preGeneratedGreetingRequestedAt?: string;
  firstPreGeneratedGreetingAudioAt?: string;
  initialGreetingRequestedAt?: string;
  firstOutboundAudioAt?: string;
  firstOutboundAudioPlayedAt?: string;
  firstRemoteAudioActivityAt?: string;
  lastRemoteAudioActivityAt?: string;
  firstRemoteSpeechAt?: string;
  firstLocalResponseAt?: string;
  answeredBy?: string; // Twilio AMD result
  // Worst outbound-audio delivery seen on this call, across every turn. A turn
  // whose audio takes longer to arrive than it takes to play starves Twilio's
  // queue, and the callee hears the gaps — see MediaStreamsBridge.
  maxOutboundAudioGapMs?: number;
  maxOutboundAudioStarvationMs?: number;
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
    finalized: false,
    from: params.from,
    to: params.to,
    startTime: now,
    transcriptBuffer: [],
    fullTranscript: [],
    preGeneratedGreetingAudio: [],
    preGeneratedGreetingAudioChunks: 0,
    preGeneratedGreetingTranscriptParts: [],
    preGeneratedGreetingTurnComplete: false,
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
