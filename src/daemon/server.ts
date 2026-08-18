import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dotdir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dotdir, "..", "..", ".env"), quiet: true });

import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import express from "express";
import { WebSocketServer, type RawData } from "ws";
import twilio from "twilio";
import { generateCallId, createSession, getSession, deleteSession, listSessions, appendEvent } from "./sessions.js";
import type { CallSession } from "./sessions.js";
import { writeTranscript, ensureDataDirs, isoNow } from "../logs/sessionLog.js";
import type { TranscriptEvent } from "../logs/sessionLog.js";
import { MediaStreamsBridge } from "./mediaStreamsBridge.js";
import { GeminiLiveSession } from "../audio/geminiLive.js";
import { buildSystemInstruction } from "../audio/systemInstruction.js";
import { readRuntime } from "../runtime.js";
import { loadAppConfig } from "../appConfig.js";
import type { AppConfig } from "../appConfig.js";
import { runPreflight } from "./preflight.js";

// --- Constants ---

const PORT = parseInt(process.env.PORT ?? "3001", 10);
// Identifies this daemon process. The tunnel probe in the preflight compares it
// against /health so a stale tunnel URL pointing at another process (or another
// daemon on this port) is a hard failure instead of a silently dead call.
const INSTANCE_ID = randomBytes(8).toString("hex");
const PID_FILE = "/tmp/outreach-daemon.pid";
const SOCKET_PATH = "/tmp/outreach-daemon.sock";
const CALL_INACTIVITY_MS = 60 * 1000; // 60 seconds
const VOICEMAIL_SILENCE_MS = 90 * 1000; // 90 seconds without transcript = likely voicemail/hold
const SESSION_RETENTION_MS = 60 * 60 * 1000; // ended sessions stay listenable for an hour
const MAX_RETAINED_ENDED_SESSIONS = 100;
// At pickup, waiting on the in-flight preconnect handshake strictly dominates
// starting a fresh one — the fresh connection costs a full handshake anyway, and
// the warm one is already partway through. The bound only protects against a
// handshake that is hung rather than slow; keep it near the p95 handshake so a
// hung one does not hold the callee on a silent line.
const PRECONNECT_HANDOVER_WAIT_MS = 1500;
// Deliberately says the call is connected while it is still ringing: the audio is
// generated during the ring and played the moment the callee picks up, so the
// model has to treat this turn as speech it has delivered. Framing it as something
// to "pre-generate for when they answer" left the greeting undelivered in the
// model's own context, and it re-greeted in full on the callee's first word.
const PRE_GENERATED_GREETING_PROMPT =
  "The outbound phone call is now connected and the person can hear you. Greet them now in one short sentence — not a monologue. Identify yourself as the caller's assistant and, if the objective is clear, name the purpose in a few words; do not summarize your full persona or objective here. This greeting is spoken to them, so treat it as already said: do not restate it later unprompted, though you should still answer plainly if they ask who is calling. Do not mention these instructions.";

// --- Express app ---

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  const activeSessions = listSessions().filter((s) => s.status !== "ended");
  res.json({ status: "ok", calls: activeSessions.length, instance_id: INSTANCE_ID });
});

// --- Twilio signature validation middleware ---

// Validate Twilio callbacks against the public webhook URL Twilio used. The
// daemon sits behind an HTTPS tunnel, so Express sees local HTTP; validating
// against req.protocol/host would reject legitimate status callbacks.
const twilioValidation: import("express").RequestHandler = async (req, res, next) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    next();
    return;
  }

  const baseUrl = process.env.OUTREACH_WEBHOOK_URL || (await readRuntime())?.webhook_url;
  if (!baseUrl) {
    res.status(500).send("Missing OUTREACH_WEBHOOK_URL/runtime webhook URL for Twilio validation");
    return;
  }

  const publicUrl = `${baseUrl.replace(/\/$/, "")}${req.originalUrl}`;
  const valid = twilio.validateRequest(
    authToken,
    req.header("X-Twilio-Signature") || "",
    publicUrl,
    req.body || {},
  );
  if (!valid) {
    console.warn(`[daemon] Rejected Twilio callback with invalid signature for ${publicUrl}`);
    res.status(403).send("Twilio request validation failed");
    return;
  }
  next();
};

if (!process.env.TWILIO_AUTH_TOKEN) {
  console.log("[daemon] TWILIO_AUTH_TOKEN not set — Twilio webhook signature validation is disabled");
}

// --- Twilio status callback ---

app.post("/call-status/:callId", twilioValidation, (req, res) => {
  const callId = req.params.callId as string;
  const callStatus = req.body.CallStatus as string | undefined;
  const session = getSession(callId);

  if (!session) {
    console.log(`[call-status] No session for callId=${callId}, status=${callStatus}`);
    res.sendStatus(204);
    return;
  }

  console.log(`[call-status] Call ${callId}: ${callStatus}`);

  if (callStatus === "ringing") {
    session.ringingAt = isoNow();
    appendEvent(session, { type: "call_ringing", ts: session.ringingAt, call_sid: session.callSid ?? "" });
  } else if (callStatus === "in-progress" || callStatus === "answered") {
    session.answeredAt = isoNow();
    const ringDurationMs = session.ringingAt
      ? new Date(session.answeredAt).getTime() - new Date(session.ringingAt).getTime()
      : undefined;
    appendEvent(session, {
      type: "call_answered",
      ts: session.answeredAt,
      ring_duration_ms: ringDurationMs ?? 0,
    });
  }
  // 'completed' status is handled by cleanup/finalizeCall paths

  res.sendStatus(204);
});

// --- Twilio AMD callback ---

app.post("/call-amd/:callId", twilioValidation, (req, res) => {
  const callId = req.params.callId as string;
  const answeredBy = req.body.AnsweredBy as string | undefined;
  const session = getSession(callId);

  if (!session) {
    console.log(`[call-amd] No session for callId=${callId}`);
    res.sendStatus(204);
    return;
  }

  if (answeredBy) {
    console.log(`[call-amd] Call ${callId}: answered_by=${answeredBy}`);
    session.answeredBy = answeredBy;
    appendEvent(session, { type: "amd_result", ts: isoNow(), answered_by: answeredBy });
  }

  res.sendStatus(204);
});

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Twilio REST client ---

let twilioClient: ReturnType<typeof twilio> | undefined;
let twilioClientKey = "";

/**
 * Reuse one Twilio client per credential pair: it owns the keep-alive HTTPS
 * agent, so only the first request of a daemon's life pays DNS + TLS. Keyed on
 * the credentials so an edited .env is still picked up (the daemon reads them
 * from process.env on every call).
 */
function getTwilioClient(accountSid: string, authToken: string): ReturnType<typeof twilio> {
  const key = `${accountSid}:${authToken}`;
  if (!twilioClient || twilioClientKey !== key) {
    twilioClient = twilio(accountSid, authToken);
    twilioClientKey = key;
  }
  return twilioClient;
}

// --- HTTP + WebSocket server ---

const httpServer = createHttpServer(app);

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  handleMediaStreamConnection(ws);
});

// --- Guardrail helpers ---

function logCallCost(session: CallSession): void {
  const durationSec = (Date.now() - session.startTime) / 1000;
  const durationMin = durationSec / 60;
  const twilioCost = durationMin * 0.014; // ~$0.014/min outbound US
  const geminiCost = durationMin * 0.01;  // ~$0.01/min audio
  console.log(JSON.stringify({
    event: "call_ended",
    id: session.id,
    duration_seconds: Math.round(durationSec),
    estimated_cost: {
      twilio_usd: +twilioCost.toFixed(4),
      gemini_usd: +geminiCost.toFixed(4),
      total_usd: +(twilioCost + geminiCost).toFixed(4),
    },
  }));
}

/**
 * Write the call transcript when a call ends.
 * Called from all call-end paths (forceHangup, handleCallHangup, bridge cleanup).
 */
async function finalizeCall(session: CallSession): Promise<void> {
  if (session.finalized) return;
  session.finalized = true;

  // Compute and append call_summary as final event
  const durationMs = Date.now() - session.startTime;
  const ringDurationMs = session.ringingAt && session.answeredAt
    ? new Date(session.answeredAt).getTime() - new Date(session.ringingAt).getTime()
    : undefined;
  const firstRemoteSpeechDelayMs = session.answeredAt && session.firstRemoteSpeechAt
    ? new Date(session.firstRemoteSpeechAt).getTime() - new Date(session.answeredAt).getTime()
    : undefined;
  const firstResponseDelayMs = session.firstRemoteSpeechAt && session.firstLocalResponseAt
    ? new Date(session.firstLocalResponseAt).getTime() - new Date(session.firstRemoteSpeechAt).getTime()
    : undefined;
  const twilioCallCreateMs = session.callCreateStartedAt && session.callPlacedAt
    ? new Date(session.callPlacedAt).getTime() - new Date(session.callCreateStartedAt).getTime()
    : undefined;
  const geminiPreconnectMs = session.geminiPreconnectStartedAt && session.geminiPreconnectConnectedAt
    ? new Date(session.geminiPreconnectConnectedAt).getTime() - new Date(session.geminiPreconnectStartedAt).getTime()
    : undefined;
  const geminiPreconnectedBeforeCall = session.geminiPreconnectConnectedAt && session.callPlacedAt
    ? new Date(session.geminiPreconnectConnectedAt).getTime() <= new Date(session.callPlacedAt).getTime()
    : false;
  const answerToStreamMs = session.answeredAt && session.mediaStreamStartedAt
    ? new Date(session.mediaStreamStartedAt).getTime() - new Date(session.answeredAt).getTime()
    : undefined;
  const streamToFirstOutboundAudioMs = session.mediaStreamStartedAt && session.firstOutboundAudioAt
    ? new Date(session.firstOutboundAudioAt).getTime() - new Date(session.mediaStreamStartedAt).getTime()
    : undefined;
  const preGeneratedGreetingRequestToFirstGeneratedAudioMs = session.preGeneratedGreetingRequestedAt && session.firstPreGeneratedGreetingAudioAt
    ? new Date(session.firstPreGeneratedGreetingAudioAt).getTime() - new Date(session.preGeneratedGreetingRequestedAt).getTime()
    : undefined;
  const preGeneratedGreetingRequestToFirstOutboundAudioMs = session.preGeneratedGreetingRequestedAt && session.firstOutboundAudioAt
    ? new Date(session.firstOutboundAudioAt).getTime() - new Date(session.preGeneratedGreetingRequestedAt).getTime()
    : undefined;
  const preGeneratedGreetingReadyBeforeStream = session.firstPreGeneratedGreetingAudioAt && session.mediaStreamStartedAt
    ? new Date(session.firstPreGeneratedGreetingAudioAt).getTime() <= new Date(session.mediaStreamStartedAt).getTime()
    : undefined;
  const preGeneratedGreetingEndedBeforeStream = session.preGeneratedGreetingSessionClosedAt && session.mediaStreamStartedAt
    ? new Date(session.preGeneratedGreetingSessionClosedAt).getTime() <= new Date(session.mediaStreamStartedAt).getTime()
    : Boolean(session.preGeneratedGreetingSessionClosedAt && !session.mediaStreamStartedAt);
  // Whether the greeting turn beat the pickup decides which handover path runs —
  // a still-streaming turn is what used to split the opening line in two.
  const preGeneratedGreetingGeneratedBeforeStream = session.preGeneratedGreetingTurnCompleteAt && session.mediaStreamStartedAt
    ? new Date(session.preGeneratedGreetingTurnCompleteAt).getTime() <= new Date(session.mediaStreamStartedAt).getTime()
    : Boolean(session.preGeneratedGreetingTurnCompleteAt && !session.mediaStreamStartedAt);
  const preGeneratedGreetingRequestToTurnCompleteMs = session.preGeneratedGreetingRequestedAt && session.preGeneratedGreetingTurnCompleteAt
    ? new Date(session.preGeneratedGreetingTurnCompleteAt).getTime() - new Date(session.preGeneratedGreetingRequestedAt).getTime()
    : undefined;
  const streamToInitialGreetingRequestMs = session.mediaStreamStartedAt && session.initialGreetingRequestedAt
    ? new Date(session.initialGreetingRequestedAt).getTime() - new Date(session.mediaStreamStartedAt).getTime()
    : undefined;
  const initialGreetingRequestToFirstOutboundAudioMs = session.initialGreetingRequestedAt && session.firstOutboundAudioAt
    ? new Date(session.firstOutboundAudioAt).getTime() - new Date(session.initialGreetingRequestedAt).getTime()
    : undefined;
  const answerToFirstOutboundAudioMs = session.answeredAt && session.firstOutboundAudioAt
    ? new Date(session.firstOutboundAudioAt).getTime() - new Date(session.answeredAt).getTime()
    : undefined;
  const streamToFirstOutboundAudioPlayedMs = session.mediaStreamStartedAt && session.firstOutboundAudioPlayedAt
    ? new Date(session.firstOutboundAudioPlayedAt).getTime() - new Date(session.mediaStreamStartedAt).getTime()
    : undefined;
  const answerToFirstOutboundAudioPlayedMs = session.answeredAt && session.firstOutboundAudioPlayedAt
    ? new Date(session.firstOutboundAudioPlayedAt).getTime() - new Date(session.answeredAt).getTime()
    : undefined;
  const firstRemoteAudioActivityDelayMs = session.answeredAt && session.firstRemoteAudioActivityAt
    ? new Date(session.firstRemoteAudioActivityAt).getTime() - new Date(session.answeredAt).getTime()
    : undefined;
  const firstRemoteAudioActivityToFirstOutboundAudioMs = session.firstRemoteAudioActivityAt && session.firstOutboundAudioAt
    ? new Date(session.firstOutboundAudioAt).getTime() - new Date(session.firstRemoteAudioActivityAt).getTime()
    : undefined;
  const firstRemoteAudioActivityToFirstOutboundAudioPlayedMs = session.firstRemoteAudioActivityAt && session.firstOutboundAudioPlayedAt
    ? new Date(session.firstOutboundAudioPlayedAt).getTime() - new Date(session.firstRemoteAudioActivityAt).getTime()
    : undefined;
  const lastRemoteAudioActivityToFirstOutboundAudioMs = session.lastRemoteAudioActivityAt && session.firstOutboundAudioAt
    ? new Date(session.firstOutboundAudioAt).getTime() - new Date(session.lastRemoteAudioActivityAt).getTime()
    : undefined;
  const lastRemoteAudioActivityToFirstOutboundAudioPlayedMs = session.lastRemoteAudioActivityAt && session.firstOutboundAudioPlayedAt
    ? new Date(session.firstOutboundAudioPlayedAt).getTime() - new Date(session.lastRemoteAudioActivityAt).getTime()
    : undefined;

  const summary: TranscriptEvent = {
    type: "call_summary",
    ts: isoNow(),
    duration_ms: durationMs,
    ...(ringDurationMs !== undefined && { ring_duration_ms: ringDurationMs }),
    ...(session.answeredBy && { answered_by: session.answeredBy }),
    wait_for_user_before_greeting: Boolean(session.waitForUserBeforeGreeting),
    ...(twilioCallCreateMs !== undefined && { twilio_call_create_ms: twilioCallCreateMs }),
    gemini_preconnected_before_call: geminiPreconnectedBeforeCall,
    ...(geminiPreconnectMs !== undefined && { gemini_preconnect_ms: geminiPreconnectMs }),
    ...(session.preconnectHandover && { preconnect_handover: session.preconnectHandover }),
    ...(session.preconnectHandoverWaitMs !== undefined && { preconnect_handover_wait_ms: session.preconnectHandoverWaitMs }),
    pre_generated_greeting_requested: Boolean(session.preGeneratedGreetingRequestedAt),
    pre_generated_greeting_audio_chunks: session.preGeneratedGreetingAudioChunks,
    pre_generated_greeting_ended_before_stream: preGeneratedGreetingEndedBeforeStream,
    pre_generated_greeting_generated_before_stream: preGeneratedGreetingGeneratedBeforeStream,
    ...(preGeneratedGreetingRequestToTurnCompleteMs !== undefined && { pre_generated_greeting_request_to_turn_complete_ms: preGeneratedGreetingRequestToTurnCompleteMs }),
    ...(preGeneratedGreetingReadyBeforeStream !== undefined && { pre_generated_greeting_ready_before_stream: preGeneratedGreetingReadyBeforeStream }),
    ...(preGeneratedGreetingRequestToFirstGeneratedAudioMs !== undefined && { pre_generated_greeting_request_to_first_generated_audio_ms: preGeneratedGreetingRequestToFirstGeneratedAudioMs }),
    ...(preGeneratedGreetingRequestToFirstOutboundAudioMs !== undefined && { pre_generated_greeting_request_to_first_outbound_audio_ms: preGeneratedGreetingRequestToFirstOutboundAudioMs }),
    ...(answerToStreamMs !== undefined && { answer_to_stream_ms: answerToStreamMs }),
    ...(streamToInitialGreetingRequestMs !== undefined && { stream_to_initial_greeting_request_ms: streamToInitialGreetingRequestMs }),
    ...(initialGreetingRequestToFirstOutboundAudioMs !== undefined && { initial_greeting_request_to_first_outbound_audio_ms: initialGreetingRequestToFirstOutboundAudioMs }),
    ...(streamToFirstOutboundAudioMs !== undefined && { stream_to_first_outbound_audio_ms: streamToFirstOutboundAudioMs }),
    ...(answerToFirstOutboundAudioMs !== undefined && { answer_to_first_outbound_audio_ms: answerToFirstOutboundAudioMs }),
    ...(streamToFirstOutboundAudioPlayedMs !== undefined && { stream_to_first_outbound_audio_played_ms: streamToFirstOutboundAudioPlayedMs }),
    ...(answerToFirstOutboundAudioPlayedMs !== undefined && { answer_to_first_outbound_audio_played_ms: answerToFirstOutboundAudioPlayedMs }),
    ...(firstRemoteAudioActivityDelayMs !== undefined && { first_remote_audio_activity_delay_ms: firstRemoteAudioActivityDelayMs }),
    ...(firstRemoteAudioActivityToFirstOutboundAudioMs !== undefined && { first_remote_audio_activity_to_first_outbound_audio_ms: firstRemoteAudioActivityToFirstOutboundAudioMs }),
    ...(firstRemoteAudioActivityToFirstOutboundAudioPlayedMs !== undefined && { first_remote_audio_activity_to_first_outbound_audio_played_ms: firstRemoteAudioActivityToFirstOutboundAudioPlayedMs }),
    ...(lastRemoteAudioActivityToFirstOutboundAudioMs !== undefined && { last_remote_audio_activity_to_first_outbound_audio_ms: lastRemoteAudioActivityToFirstOutboundAudioMs }),
    ...(lastRemoteAudioActivityToFirstOutboundAudioPlayedMs !== undefined && { last_remote_audio_activity_to_first_outbound_audio_played_ms: lastRemoteAudioActivityToFirstOutboundAudioPlayedMs }),
    ...(firstRemoteSpeechDelayMs !== undefined && { first_remote_speech_delay_ms: firstRemoteSpeechDelayMs }),
    ...(firstResponseDelayMs !== undefined && { first_response_delay_ms: firstResponseDelayMs }),
  };
  appendEvent(session, summary);

  try {
    await writeTranscript(session.id, session.fullTranscript);
  } finally {
    // finalizedAt gates session reaping, so it is only stamped once the write has
    // settled — a session can never be dropped while its transcript is in flight.
    session.finalizedAt = Date.now();
    // The greeting audio is base64 24kHz PCM (~200KB for a 3s greeting) and is
    // never drained for a call that was not answered. The transcript is on disk
    // now, so nothing downstream needs either buffer. transcriptBuffer and
    // fullTranscript stay: a final `call listen` reads the tail of one and
    // status/listen summaries read the other.
    session.preGeneratedGreetingAudio = [];
    session.preGeneratedGreetingTranscriptParts = [];
  }
}

async function forceHangup(session: CallSession, reason: string): Promise<void> {
  if (session.status === "ended") return;

  console.log(`[daemon] ${reason}`);

  // Append call_ended event for the forced hangup
  appendEvent(session, {
    type: "call_ended",
    ts: isoNow(),
    reason,
    duration_ms: Date.now() - session.startTime,
  });

  // Hang up via Twilio REST API
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (accountSid && authToken && session.callSid) {
    try {
      const client = getTwilioClient(accountSid, authToken);
      await client.calls(session.callSid).update({ status: "completed" });
    } catch (err) {
      console.error(`[daemon] Failed to hangup call ${session.id} via Twilio:`, (err as Error).message);
    }
  }

  // Clean up bridge (closes Gemini session + Twilio WS)
  if (session.bridge && session.bridge instanceof MediaStreamsBridge) {
    (session.bridge as MediaStreamsBridge).cleanup();
  }
  // No bridge on a call that never got answered — the warm session is ours to close.
  abandonPreconnect(session);

  session.status = "ended";
  logCallCost(session);
  await finalizeCall(session);
}

/**
 * Give up on the warm Gemini session for a call. Every path that abandons a call
 * without handing the warm session to a bridge must call this, otherwise the
 * pre-connect either parks a live WebSocket on the session forever or self-closes
 * only by luck.
 */
function abandonPreconnect(session: CallSession): void {
  session.preconnectAbandoned = true;
  session.preConnectedGemini?.close();
  session.preConnectedGemini = undefined;
  const inFlight = session.preConnectingGemini;
  session.preConnectingGemini = undefined;
  inFlight?.then((late) => late?.close()).catch(() => undefined);
}

function notePreGeneratedGreetingTurnComplete(session: CallSession): void {
  if (session.preGeneratedGreetingTurnComplete) return;
  session.preGeneratedGreetingTurnComplete = true;
  session.preGeneratedGreetingTurnCompleteAt = isoNow();
}

function requestPreGeneratedGreeting(session: CallSession, geminiSession: GeminiLiveSession): void {
  if (!session.callPlacedAt || session.mediaStreamStartedAt || session.preGeneratedGreetingRequestedAt || geminiSession.isClosed) {
    return;
  }
  session.preGeneratedGreetingRequestedAt = isoNow();
  geminiSession.sendTextTurn(PRE_GENERATED_GREETING_PROMPT);
}

async function waitForPreconnectedGemini(session: CallSession, timeoutMs: number): Promise<GeminiLiveSession | undefined> {
  if (!session.preConnectingGemini) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      session.preConnectingGemini,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return result ?? undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A warm session that died during ringing must never be adopted: the bridge skips
 * its own connect for a pre-connected session, and every send on a closed session
 * silently no-ops, so the call would greet (from the buffer) and then go deaf.
 */
function usableWarmSession(gemini: GeminiLiveSession | undefined): GeminiLiveSession | undefined {
  return gemini && !gemini.isClosed ? gemini : undefined;
}

/** Re-read the status after an await: hangup paths can end a call mid-handover. */
function callEnded(session: CallSession): boolean {
  return session.status === "ended";
}

/**
 * Callee audio buffered during the handover wait would reach the warm session as
 * one burst immediately before the greeting, and Gemini's automatic VAD would
 * answer that burst instead of greeting. Control frames are kept.
 * In --wait-for-user mode there is no greeting to protect and this audio is the
 * turn trigger, so callers keep the buffer intact there.
 */
function dropBufferedInboundAudio(messages: RawData[]): RawData[] {
  return messages.filter((data) => {
    try {
      return (JSON.parse(data.toString()) as { event?: string }).event !== "media";
    } catch {
      return true;
    }
  });
}

function handleMediaStreamConnection(ws: import("ws").WebSocket): void {
  console.log(`[media-stream] WebSocket connected — waiting for start event with callId`);

  // Twilio's <Stream> delivers customParameters in the "start" event, not in the URL.
  // We listen for the first message to resolve the session, then set up the bridge.
  let initialized = false;
  let initializing = false;
  let wsClosed = false;
  // Set once the start event is matched to a call: from then on this connection owns
  // that call's warm Gemini session and must close it on every path that gives up.
  let startedSession: CallSession | undefined;
  const pendingBridgeMessages: RawData[] = [];

  ws.on("message", async (data) => {
    if (initialized) return; // Bridge handles subsequent messages
    if (initializing) {
      pendingBridgeMessages.push(data);
      return;
    }

    try {
      const msg = JSON.parse(data.toString()) as {
        event: string;
        start?: {
          streamSid?: string;
          callSid?: string;
          customParameters?: Record<string, string>;
        };
      };

      if (msg.event === "start") {
        initializing = true;
        const callId = msg.start?.customParameters?.callId ?? "";
        const session = callId ? getSession(callId) : undefined;

        if (!session) {
          console.error(`[media-stream] No session found for callId=${callId}`);
          ws.close();
          return;
        }

        // Validate CallSid: the session already has callSid from Twilio REST API (set at call creation).
        // If the inbound stream reports a different CallSid, it may be a forged connection.
        const inboundCallSid = msg.start?.callSid;
        if (session.callSid && inboundCallSid && inboundCallSid !== session.callSid) {
          console.warn(
            `[media-stream] CallSid mismatch for call ${callId}: ` +
            `expected ${session.callSid}, got ${inboundCallSid} — rejecting connection`
          );
          ws.close();
          return;
        }

        console.log(`[media-stream] Start event received for call ${callId}`);
        startedSession = session;
        session.ws = ws;
        session.lastActivityTime = Date.now();
        if (msg.start?.streamSid) {
          session.streamSid = msg.start.streamSid;
          if (!session.mediaStreamStartedAt) {
            session.mediaStreamStartedAt = isoNow();
            appendEvent(session, {
              type: "media_stream_started",
              ts: session.mediaStreamStartedAt,
              stream_sid: msg.start.streamSid,
              ...(inboundCallSid ? { call_sid: inboundCallSid } : {}),
            });
          }
        }
        if (inboundCallSid) session.callSid = inboundCallSid;
        // The replacement stream a `send_dtmf` asked for has arrived, so the next
        // teardown is a real call end and must finalize the transcript.
        session.expectingStreamReconnect = false;
        session.status = "in_progress";

        const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (!apiKey) {
          console.error("[media-stream] GOOGLE_GENERATIVE_AI_API_KEY not set");
          abandonPreconnect(session);
          // The call is answered: ending it names the cause, where a bare close
          // would leave a silent line for the inactivity sweep to mislabel.
          await forceHangup(session, `Call ${callId} — Gemini unavailable: GOOGLE_GENERATIVE_AI_API_KEY not set`)
            .catch((err) => {
              console.error(`[media-stream] Failed to hang up call ${callId}:`, (err as Error).message);
            });
          ws.close();
          return;
        }

        const appConfig = await loadAppConfig();
        const systemInstruction = session.systemInstruction ?? "You are a helpful phone assistant.";

        // Use the warm Gemini session if it is ready, otherwise wait for the
        // in-flight handshake instead of racing it with a second, colder one.
        let preConnected = usableWarmSession(session.preConnectedGemini);
        let handover: "warm" | "handover" | "fresh_fallback" | "none" = preConnected ? "warm" : "none";
        let waitedMs = 0;
        if (!preConnected && session.preConnectingGemini) {
          const waitStart = Date.now();
          preConnected = usableWarmSession(await waitForPreconnectedGemini(session, PRECONNECT_HANDOVER_WAIT_MS));
          waitedMs = Date.now() - waitStart;
          // A preconnect that lands in the same tick as the timeout parks itself on
          // the session without winning the race — adopt it rather than orphan it.
          preConnected ??= usableWarmSession(session.preConnectedGemini);
          handover = preConnected ? "handover" : "fresh_fallback";
        }
        if (preConnected) {
          session.preConnectedGemini = undefined; // consumed
          session.preConnectingGemini = undefined;
        } else {
          // Stop a late preconnect from being adopted, and close it if it lands.
          abandonPreconnect(session);
          // Any buffered greeting belongs to the session we just gave up on. Playing
          // it through a fresh session would leave that session unaware it greeted,
          // so let the fresh session greet for itself instead.
          session.preGeneratedGreetingAudio = [];
          session.preGeneratedGreetingTranscriptParts = [];
        }
        session.preconnectHandover = handover;
        session.preconnectHandoverWaitMs = waitedMs;
        appendEvent(session, {
          type: "preconnect_handover",
          ts: isoNow(),
          outcome: handover,
          waited_ms: waitedMs,
        });

        // The callee can hang up while we wait: with no live Twilio socket there is
        // nothing to bridge to, and the bridge's own close handler would never fire.
        // The session is already "in_progress", so it also has to be ended here —
        // otherwise status/listen report a live call and teardown refuses for a
        // minute, until the inactivity sweep mislabels it as an auto-hangup.
        if (wsClosed || callEnded(session)) {
          console.log(`[media-stream] Call ${callId} ended during Gemini handover — discarding warm session`);
          preConnected?.close();
          abandonPreconnect(session); // forceHangup below returns early if the call already ended
          await forceHangup(session, `Call ${callId} — callee disconnected during Gemini handover`)
            .catch((err) => {
              console.error(`[media-stream] Failed to end call ${callId}:`, (err as Error).message);
            });
          return;
        }

        const bridge = new MediaStreamsBridge({
          twilioWs: ws,
          callId,
          session,
          apiKey,
          geminiConfig: appConfig.gemini,
          systemInstruction,
          preConnectedGemini: preConnected,
          initialTwilioMessages: session.waitForUserBeforeGreeting
            ? pendingBridgeMessages.splice(0)
            : dropBufferedInboundAudio(pendingBridgeMessages.splice(0)),
          onCleanup: () => {
            finalizeCall(session).catch((err) => {
              console.error(`[daemon] Failed to finalize call ${callId}:`, err);
            });
          },
        });

        session.bridge = bridge;
        initialized = true;

        // G1: Hard max call duration timer
        if (session.maxDurationMs) {
          setTimeout(() => {
            if (session.status !== "ended") {
              forceHangup(session, `Call ${callId} hit max duration (${Math.round(session.maxDurationMs! / 1000)}s) — force hangup`);
            }
          }, session.maxDurationMs);
        }

        if (preConnected) {
          console.log(`[media-stream] Using pre-connected Gemini session for call ${callId}`);
          if (!session.waitForUserBeforeGreeting) bridge.sendInitialGreeting();
        } else {
          // Fallback: connect Gemini now (pre-connect failed or wasn't attempted)
          bridge.connectGemini()
            .then(() => {
              if (!session.waitForUserBeforeGreeting) bridge.sendInitialGreeting();
            })
            .catch((err) => {
              console.error(`[media-stream] Failed to connect Gemini for call ${callId}:`, (err as Error).message);
              appendEvent(session, { type: "preconnect_failed", ts: isoNow(), message: (err as Error).message });
              // Without Gemini there is no call — hang up instead of leaving the
              // callee on a silent line until the inactivity sweep. forceHangup
              // cleans up the bridge and finalizes (both are idempotent).
              forceHangup(session, `Call ${callId} — Gemini unavailable: ${(err as Error).message}`)
                .catch((hangupErr) => {
                  console.error(`[media-stream] Failed to hang up call ${callId}:`, (hangupErr as Error).message);
                });
            });
        }
      }
    } catch (err) {
      if (!startedSession) return; // non-JSON or unexpected message before the start event
      // Anything thrown after the start event (config load, bridge construction)
      // leaves an answered call with no bridge, so the warm session has no owner
      // and the callee is on a silent line. End it with the real cause instead of
      // letting the 60s sweep relabel it as an inactivity hangup.
      console.error(`[media-stream] Failed to initialize call ${startedSession.id}:`, (err as Error).message);
      const failed = startedSession;
      abandonPreconnect(failed);
      await forceHangup(failed, `Call ${failed.id} — media stream setup failed: ${(err as Error).message}`)
        .catch((hangupErr) => {
          console.error(`[media-stream] Failed to hang up call ${failed.id}:`, (hangupErr as Error).message);
        });
      ws.close();
    }
  });

  ws.on("close", () => {
    wsClosed = true;
    if (!initialized) {
      console.log("[media-stream] WebSocket closed before initialization");
      if (startedSession) abandonPreconnect(startedSession);
    }
  });
}

// --- IPC server (Unix domain socket) ---

type IpcMethod =
  | "call.place"
  | "call.listen"
  | "call.steer"
  | "call.status"
  | "call.hangup"
  | "daemon.preflight";

async function handleIpcMessage(msg: {
  method: IpcMethod;
  params: Record<string, unknown>;
}): Promise<object> {
  switch (msg.method) {
    case "call.place":
      return handleCallPlace(msg.params);
    case "call.listen":
      return handleCallListen(msg.params);
    case "call.steer":
      return handleCallSteer(msg.params);
    case "call.status":
      return handleCallStatus(msg.params);
    case "call.hangup":
      return handleCallHangup(msg.params);
    case "daemon.preflight":
      return handleDaemonPreflight();
    default:
      return { error: "unknown_method", method: msg.method };
  }
}

/**
 * Preflight is an IPC method, not an HTTP route: httpServer is published to the
 * internet through the tunnel, so an HTTP endpoint would let anyone spend our
 * Twilio/Gemini quota and read back the resolved config and data-repo paths.
 */
async function handleDaemonPreflight(): Promise<object> {
  // Same resolution order as handleCallPlace, so the preflight validates the URL
  // the call would actually use.
  let webhookUrl = process.env.OUTREACH_WEBHOOK_URL;
  if (!webhookUrl) {
    webhookUrl = (await readRuntime())?.webhook_url;
  }

  // A stored startup error can be stale — the operator may have fixed the config
  // since — so re-attempt the preload rather than reporting a solved problem.
  if (startupPreloadError) {
    try {
      await preloadCallPath();
      startupPreloadError = undefined;
    } catch (err) {
      startupPreloadError = (err as Error).message;
    }
  }

  const report = await runPreflight({
    webhookUrl: webhookUrl ?? "",
    instanceId: INSTANCE_ID,
    activeCalls: listSessions().filter((s) => s.status !== "ended").length,
  });

  if (startupPreloadError) {
    report.checks.unshift({
      name: "daemon_startup",
      ok: false,
      status: "fail",
      detail: `startup preload failed: ${startupPreloadError}`,
      hint: "The daemon is listening but could not warm the config/prompt/transcript path — the checks below name the underlying problem.",
    });
    report.ok = false;
  }

  return { ...report, instance_id: INSTANCE_ID };
}

async function handleCallPlace(params: Record<string, unknown>): Promise<object> {
  const to = params.to as string;
  const from = params.from as string;
  const objective = (params.objective as string) || undefined;
  const persona = (params.persona as string) || undefined;
  const hangupWhen = (params.hangupWhen as string) || undefined;
  const maxDuration = (params.maxDuration as number) || undefined;
  const waitForUserBeforeGreeting = params.waitForUserBeforeGreeting === true;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return { error: "config_error", message: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set" };
  }

  // Resolve webhook URL from env or runtime.json
  let webhookBaseUrl = process.env.OUTREACH_WEBHOOK_URL;
  if (!webhookBaseUrl) {
    const runtime = await readRuntime();
    if (runtime?.webhook_url) {
      webhookBaseUrl = runtime.webhook_url;
    }
  }
  if (!webhookBaseUrl) {
    return { error: "config_error", message: "OUTREACH_WEBHOOK_URL must be set (or run 'outreach call init')" };
  }

  // Both are warmed at daemon startup, so this normally costs nothing. Resolved
  // before the session exists: a config error would otherwise leave a phantom
  // 'ringing' session behind, and the IPC layer would report it as
  // {"error":"internal"} with no cause.
  let appConfig: AppConfig;
  let sysInstruction: string;
  try {
    appConfig = await loadAppConfig();
    sysInstruction = await buildSystemInstruction({
      identity: appConfig.identity,
      persona: persona || appConfig.voice_agent.default_persona,
      objective,
      hangupWhen,
    });
  } catch (err) {
    return { error: "config_error", message: (err as Error).message };
  }

  const id = generateCallId();
  const session = createSession({ id, from, to });

  // G1: Set max duration from flag or config default
  const maxDurationSec = maxDuration ?? appConfig.call.max_duration_seconds;
  session.maxDurationMs = maxDurationSec * 1000;
  session.waitForUserBeforeGreeting = waitForUserBeforeGreeting;
  session.systemInstruction = sysInstruction;

  // Extract host from webhook URL for WebSocket connection
  let wsHost: string;
  try {
    wsHost = new URL(webhookBaseUrl).host;
  } catch {
    wsHost = `localhost:${PORT}`;
  }

  const twiml = `<Response><Connect><Stream url="wss://${wsHost}/media-stream"><Parameter name="callId" value="${escapeXml(id)}" /></Stream></Connect></Response>`;

  // Pre-connect Gemini session so it's warm when callee answers (issue #9)
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    session.status = "ended";
    return { error: "config_error", message: "GOOGLE_GENERATIVE_AI_API_KEY not set" };
  }

  const geminiSession = new GeminiLiveSession({
    apiKey,
    geminiConfig: appConfig.gemini,
    systemInstruction: sysInstruction,
    // During ringing, buffer the greeting audio so it can be flushed as soon as
    // Twilio starts the media stream.
    onAudio: (base64Pcm24k: string) => {
      if (!session.firstPreGeneratedGreetingAudioAt) {
        session.firstPreGeneratedGreetingAudioAt = isoNow();
      }
      session.preGeneratedGreetingAudio.push(base64Pcm24k);
      session.preGeneratedGreetingAudioChunks += 1;
    },
    onTranscript: (speaker: "remote" | "local", text: string) => {
      if (speaker === "local") {
        session.preGeneratedGreetingTranscriptParts.push(text);
      }
    },
    onToolCall: () => {},
    // Without these, "the greeting turn finished" has no signal at all: pickup
    // cannot tell a complete greeting from one still streaming, and a turn that
    // completed during ringing leaves the flushed audio with nothing to finalize
    // it. Both arrive for a normal turn (generation first, then turn); first wins.
    onGenerationComplete: () => {
      notePreGeneratedGreetingTurnComplete(session);
    },
    onTurnComplete: () => {
      notePreGeneratedGreetingTurnComplete(session);
    },
    onInterrupted: () => {},
    onEnd: () => {
      session.preGeneratedGreetingSessionClosedAt = isoNow();
      console.log(`[daemon] Pre-connected Gemini session ended before media stream for call ${id}`);
      // Only fires when the remote end closed the socket — our own close() never
      // calls back. A rejected key/model/quota arrives exactly this way, after a
      // connect() that already resolved, so record it as the recoverable
      // pre-connect failure it is (pickup falls back to a fresh session).
      appendEvent(session, {
        type: "preconnect_failed",
        ts: session.preGeneratedGreetingSessionClosedAt,
        message: geminiSession.closeReason
          ?? "the pre-connected Gemini session closed while the call was ringing",
      });
    },
  });

  const preconnectPromise = (async (): Promise<GeminiLiveSession | null> => {
    session.geminiPreconnectStartedAt = isoNow();
    try {
      await geminiSession.connect();
      session.geminiPreconnectConnectedAt = isoNow();
      // A started media stream means the callee picked up and the pickup path
      // *wants* this warm session, so it must not be a reason to throw it away.
      // Only an explicit abandonment, an ended call, or a bridge that already owns
      // a different session justifies closing it here.
      if (session.status === "ended" || session.preconnectAbandoned || session.bridge) {
        geminiSession.close();
        return null;
      }
      session.preConnectedGemini = geminiSession;
      console.log(`[daemon] Gemini pre-connected for call ${id}`);
      if (!session.waitForUserBeforeGreeting) {
        requestPreGeneratedGreeting(session, geminiSession);
      }
      return geminiSession;
    } catch (err) {
      console.error(`[daemon] Gemini pre-connect failed for call ${id}:`, (err as Error).message);
      // Daemon logs are not visible to the caller — put the failure in the
      // transcript so 'call listen'/'call status' can report it.
      appendEvent(session, { type: "preconnect_failed", ts: isoNow(), message: (err as Error).message });
      return null;
    }
  })();
  session.preConnectingGemini = preconnectPromise;

  try {
    const client = getTwilioClient(accountSid, authToken);
    session.callCreateStartedAt = isoNow();
    const twilioCall = await client.calls.create({
      to,
      from,
      twiml,
      statusCallback: `${webhookBaseUrl}/call-status/${id}`,
      statusCallbackEvent: ["ringing", "answered", "completed"],
      machineDetection: "DetectMessageEnd",
      asyncAmd: "true",
      asyncAmdStatusCallback: `${webhookBaseUrl}/call-amd/${id}`,
      asyncAmdStatusCallbackMethod: "POST",
    });

    session.callSid = twilioCall.sid;
    session.callPlacedAt = isoNow();
    appendEvent(session, { type: "call_placed", ts: session.callPlacedAt, from, to });
    if (session.preConnectedGemini && !session.waitForUserBeforeGreeting) {
      requestPreGeneratedGreeting(session, session.preConnectedGemini);
    }

    return {
      id,
      status: "ringing",
      amd: true,
      wait_for_user_before_greeting: waitForUserBeforeGreeting,
    };
  } catch (err) {
    session.status = "ended";
    // Clean up pre-connected Gemini if Twilio call fails
    preconnectPromise.then((connected) => connected?.close()).catch(() => undefined);
    geminiSession.close();
    return { error: "twilio_error", message: (err as Error).message };
  }
}

async function handleCallListen(params: Record<string, unknown>): Promise<object> {
  const id = params.id as string;

  const session = getSession(id);
  if (!session) {
    return { error: "session_not_found", message: `No session with id ${id}` };
  }

  const newEntries = session.transcriptBuffer.slice(session.lastListenIndex);
  session.lastListenIndex = session.transcriptBuffer.length;
  session.lastActivityTime = Date.now();
  const silenceMs = Date.now() - session.lastSpeechTime;
  const summary = latestCallSummary(session);

  return {
    id,
    status: session.status,
    transcript: newEntries,
    silence_ms: silenceMs,
    ...(summary ? { summary } : {}),
  };
}

async function handleCallSteer(params: Record<string, unknown>): Promise<object> {
  const id = params.id as string;
  const text = params.text as string;
  const mode = params.mode === "say" ? "say" : "nudge";

  const session = getSession(id);
  if (!session) {
    return { error: "session_not_found", message: `No session with id ${id}` };
  }
  if (session.status === "ended") {
    return { error: "call_not_active", message: "Call has already ended" };
  }
  if (!session.bridge || !(session.bridge instanceof MediaStreamsBridge)) {
    return { error: "bridge_not_ready", message: "Call has not been answered yet — no live session to steer" };
  }

  (session.bridge as MediaStreamsBridge).steerGemini(text, mode);
  appendEvent(session, { type: "call_steered", ts: isoNow(), mode, text });

  return { id, status: "steered", mode };
}

function latestCallSummary(session: CallSession): TranscriptEvent | undefined {
  for (let i = session.fullTranscript.length - 1; i >= 0; i--) {
    const event = session.fullTranscript[i];
    if (event?.type === "call_summary") return event;
  }
  return undefined;
}

async function handleCallStatus(params: Record<string, unknown>): Promise<object> {
  const id = params.id as string;

  const session = getSession(id);
  if (!session) {
    return { error: "session_not_found", message: `No session with id ${id}` };
  }
  const summary = latestCallSummary(session);

  const statusToPhase: Record<string, string> = {
    ringing: "ringing",
    in_progress: "answered",
    ended: "hungup",
  };

  const hint = session.status === "ended"
    ? `Call has ended. Use 'outreach call listen --id ${id}' to get the full transcript.`
    : `Call is still active. Use 'outreach call listen --id ${id}' to get the transcript so far.`;

  return {
    id,
    status: session.status,
    phase: statusToPhase[session.status] ?? session.status,
    duration_sec: Math.floor((Date.now() - session.startTime) / 1000),
    from: session.from,
    to: session.to,
    hint,
    ...(summary ? { summary } : {}),
  };
}

async function handleCallHangup(params: Record<string, unknown>): Promise<object> {
  const id = params.id as string;

  const session = getSession(id);
  if (!session) {
    return { error: "session_not_found", message: `No session with id ${id}` };
  }
  if (session.status === "ended") {
    return { error: "call_not_active", message: "Call has already ended" };
  }

  const durationMs = Date.now() - session.startTime;

  // Append call_ended event
  appendEvent(session, {
    type: "call_ended",
    ts: isoNow(),
    reason: "hangup command",
    duration_ms: durationMs,
  });

  // Hang up via Twilio REST API
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (accountSid && authToken && session.callSid) {
    try {
      const client = getTwilioClient(accountSid, authToken);
      await client.calls(session.callSid).update({ status: "completed" });
    } catch (err) {
      console.error(`[daemon] Failed to hangup call ${id} via Twilio:`, (err as Error).message);
    }
  }

  // Clean up bridge (handles Gemini session close + Twilio WS close)
  if (session.bridge && session.bridge instanceof MediaStreamsBridge) {
    (session.bridge as MediaStreamsBridge).cleanup();
  }
  // Hangup during ringing has no bridge — the warm session is ours to close.
  abandonPreconnect(session);

  session.status = "ended";
  logCallCost(session);
  await finalizeCall(session);

  return { id, status: "ended", duration_sec: Math.floor(durationMs / 1000) };
}

const ipcServer = createNetServer((socket) => {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      try {
        const msg = JSON.parse(line) as {
          method: IpcMethod;
          params: Record<string, unknown>;
        };
        handleIpcMessage(msg)
          .then((response) => {
            socket.write(JSON.stringify(response) + "\n");
          })
          .catch((err) => {
            socket.write(JSON.stringify({ error: "internal", message: (err as Error).message }) + "\n");
          });
      } catch {
        socket.write(JSON.stringify({ error: "invalid_json" }) + "\n");
      }
    }
  });
});

// --- Call cost guards & session reaping ---

// The daemon lives from `call init` until `call teardown` and never exits on its
// own: lifecycle belongs to the orchestrator that runs init, spawns sub-agents,
// then tears down, and a daemon that walks away mid-session breaks that contract.
// The cost guards below (max-duration, G2 inactivity, G3 voicemail) are what bound
// spend; the idle self-shutdown this replaced only ever fired with zero active
// calls, so it never guarded cost — it just made runtime.json unreliable.

/**
 * When an ended session became reapable. finalizeCall stamps finalizedAt only
 * after the transcript write settles, so a finalized session without it still has
 * a write in flight and must be left alone. A session that ended without ever
 * finalizing (e.g. Twilio rejected the place) has no transcript to wait for.
 */
function reapableSince(session: CallSession): number | undefined {
  return session.finalized ? session.finalizedAt : session.lastActivityTime;
}

// With an immortal daemon the session map would otherwise grow for the life of the
// process, retaining every transcript twice plus the system instruction per call.
function reapEndedSessions(now: number): void {
  const retained: Array<{ id: string; since: number }> = [];

  for (const session of listSessions()) {
    if (session.status !== "ended") continue;
    const since = reapableSince(session);
    if (since === undefined) continue;
    if (now - since > SESSION_RETENTION_MS) {
      deleteSession(session.id);
      continue;
    }
    retained.push({ id: session.id, since });
  }

  const excess = retained.length - MAX_RETAINED_ENDED_SESSIONS;
  if (excess > 0) {
    retained.sort((a, b) => a.since - b.since);
    for (const { id } of retained.slice(0, excess)) deleteSession(id);
  }
}

const activityInterval = setInterval(() => {
  const now = Date.now();
  for (const session of listSessions()) {
    if (session.status === "ended") continue;

    // G2: Inactivity timer — no audio activity at all
    if (now - session.lastActivityTime > CALL_INACTIVITY_MS) {
      forceHangup(session, `Call ${session.id} inactive for 60s — auto-hangup`);
      continue;
    }

    // G3: Voicemail/hold music detection — audio flowing but no transcript
    if (
      now - session.lastActivityTime < CALL_INACTIVITY_MS &&
      now - session.lastTranscriptTime > VOICEMAIL_SILENCE_MS
    ) {
      forceHangup(session, `Call ${session.id} — no conversational activity detected (likely voicemail/hold music) — auto-hangup`);
    }
  }

  reapEndedSessions(now);
}, 10_000);

// --- Lifecycle ---

async function cleanup(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // ignore
  }
  try {
    await unlink(SOCKET_PATH);
  } catch {
    // ignore
  }
}

function shutdown(): void {
  console.log("[daemon] Shutting down...");
  clearInterval(activityInterval);

  wss.close();
  httpServer.close();
  ipcServer.close();

  cleanup().then(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Start ---

let startupPreloadError: string | undefined;

/**
 * Warm everything the first `call place` would otherwise do inline: YAML parse,
 * prompt file read, transcript directory creation. loadAppConfig and the static
 * prompt are both process-cached, so this is a one-time cost at startup instead
 * of latency on the first call.
 */
async function preloadCallPath(): Promise<void> {
  const appConfig = await loadAppConfig();
  await buildSystemInstruction({
    identity: appConfig.identity,
    persona: appConfig.voice_agent.default_persona,
  });
  await ensureDataDirs();
}

async function start(): Promise<void> {
  // Clean up stale socket file
  try {
    await unlink(SOCKET_PATH);
  } catch {
    // ignore if not exists
  }

  // Write PID file
  await writeFile(PID_FILE, String(process.pid), "utf-8");

  // Start IPC server
  ipcServer.listen(SOCKET_PATH, () => {
    console.log(`[daemon] IPC listening on ${SOCKET_PATH}`);
  });

  // Start HTTP server
  httpServer.listen(PORT, () => {
    console.log(`[daemon] HTTP listening on port ${PORT}`);
  });

  // A broken config must not stop the daemon from listening: /health answering is
  // what lets the preflight report the real reason instead of the CLI guessing
  // "daemon failed to start".
  try {
    await preloadCallPath();
  } catch (err) {
    startupPreloadError = (err as Error).message;
    console.error("[daemon] Startup preload failed:", startupPreloadError);
  }
}

start().catch((err) => {
  console.error("[daemon] Failed to start:", err);
  process.exit(1);
});
