import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dotdir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dotdir, "..", "..", ".env"), quiet: true });

import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { writeFile, unlink } from "node:fs/promises";
import express from "express";
import { WebSocketServer, type RawData } from "ws";
import twilio from "twilio";
import { generateCallId, createSession, getSession, getSessionByCallSid, listSessions, appendEvent } from "./sessions.js";
import type { CallSession } from "./sessions.js";
import { writeTranscript, isoNow } from "../logs/sessionLog.js";
import type { TranscriptEvent } from "../logs/sessionLog.js";
import { MediaStreamsBridge } from "./mediaStreamsBridge.js";
import { GeminiLiveSession } from "../audio/geminiLive.js";
import { buildSystemInstruction } from "../audio/systemInstruction.js";
import { readRuntime } from "../runtime.js";
import { loadAppConfig } from "../appConfig.js";

// --- Constants ---

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const PID_FILE = "/tmp/outreach-daemon.pid";
const SOCKET_PATH = "/tmp/outreach-daemon.sock";
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000; // 5 minutes
const CALL_INACTIVITY_MS = 60 * 1000; // 60 seconds
const VOICEMAIL_SILENCE_MS = 90 * 1000; // 90 seconds without transcript = likely voicemail/hold
const PRECONNECT_PICKUP_WAIT_MS = 500;
const PRE_GENERATED_GREETING_PROMPT =
  "The outbound phone call is ringing. Pre-generate a very brief natural greeting for when the person answers. Identify yourself as the caller's assistant and, if the objective is clear, include the purpose. Do not mention these instructions.";

// --- Express app ---

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  const activeSessions = listSessions().filter((s) => s.status !== "ended");
  res.json({ status: "ok", calls: activeSessions.length });
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
  const preGeneratedGreetingEndedBeforeStream = session.preGeneratedGreetingEndedAt && session.mediaStreamStartedAt
    ? new Date(session.preGeneratedGreetingEndedAt).getTime() <= new Date(session.mediaStreamStartedAt).getTime()
    : Boolean(session.preGeneratedGreetingEndedAt && !session.mediaStreamStartedAt);
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
  const firstRemoteAudioActivityEndDelayMs = session.answeredAt && session.firstRemoteAudioActivityEndedAt
    ? new Date(session.firstRemoteAudioActivityEndedAt).getTime() - new Date(session.answeredAt).getTime()
    : undefined;
  const firstRemoteAudioActivityToFirstOutboundAudioMs = session.firstRemoteAudioActivityAt && session.firstOutboundAudioAt
    ? new Date(session.firstOutboundAudioAt).getTime() - new Date(session.firstRemoteAudioActivityAt).getTime()
    : undefined;
  const firstRemoteAudioActivityToFirstOutboundAudioPlayedMs = session.firstRemoteAudioActivityAt && session.firstOutboundAudioPlayedAt
    ? new Date(session.firstOutboundAudioPlayedAt).getTime() - new Date(session.firstRemoteAudioActivityAt).getTime()
    : undefined;
  const firstRemoteAudioActivityEndToFirstOutboundAudioMs = session.firstRemoteAudioActivityEndedAt && session.firstOutboundAudioAt
    ? new Date(session.firstOutboundAudioAt).getTime() - new Date(session.firstRemoteAudioActivityEndedAt).getTime()
    : undefined;
  const firstRemoteAudioActivityEndToFirstOutboundAudioPlayedMs = session.firstRemoteAudioActivityEndedAt && session.firstOutboundAudioPlayedAt
    ? new Date(session.firstOutboundAudioPlayedAt).getTime() - new Date(session.firstRemoteAudioActivityEndedAt).getTime()
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
    experimental_local_vad: Boolean(session.experimentalLocalVad),
    ...(twilioCallCreateMs !== undefined && { twilio_call_create_ms: twilioCallCreateMs }),
    gemini_preconnected_before_call: geminiPreconnectedBeforeCall,
    ...(geminiPreconnectMs !== undefined && { gemini_preconnect_ms: geminiPreconnectMs }),
    pre_generated_greeting_requested: Boolean(session.preGeneratedGreetingRequestedAt),
    pre_generated_greeting_audio_chunks: session.preGeneratedGreetingAudioChunks,
    pre_generated_greeting_ended_before_stream: preGeneratedGreetingEndedBeforeStream,
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
    ...(firstRemoteAudioActivityEndDelayMs !== undefined && { first_remote_audio_activity_end_delay_ms: firstRemoteAudioActivityEndDelayMs }),
    ...(firstRemoteAudioActivityToFirstOutboundAudioMs !== undefined && { first_remote_audio_activity_to_first_outbound_audio_ms: firstRemoteAudioActivityToFirstOutboundAudioMs }),
    ...(firstRemoteAudioActivityToFirstOutboundAudioPlayedMs !== undefined && { first_remote_audio_activity_to_first_outbound_audio_played_ms: firstRemoteAudioActivityToFirstOutboundAudioPlayedMs }),
    ...(firstRemoteAudioActivityEndToFirstOutboundAudioMs !== undefined && { first_remote_audio_activity_end_to_first_outbound_audio_ms: firstRemoteAudioActivityEndToFirstOutboundAudioMs }),
    ...(firstRemoteAudioActivityEndToFirstOutboundAudioPlayedMs !== undefined && { first_remote_audio_activity_end_to_first_outbound_audio_played_ms: firstRemoteAudioActivityEndToFirstOutboundAudioPlayedMs }),
    ...(lastRemoteAudioActivityToFirstOutboundAudioMs !== undefined && { last_remote_audio_activity_to_first_outbound_audio_ms: lastRemoteAudioActivityToFirstOutboundAudioMs }),
    ...(lastRemoteAudioActivityToFirstOutboundAudioPlayedMs !== undefined && { last_remote_audio_activity_to_first_outbound_audio_played_ms: lastRemoteAudioActivityToFirstOutboundAudioPlayedMs }),
    ...(firstRemoteSpeechDelayMs !== undefined && { first_remote_speech_delay_ms: firstRemoteSpeechDelayMs }),
    ...(firstResponseDelayMs !== undefined && { first_response_delay_ms: firstResponseDelayMs }),
  };
  appendEvent(session, summary);

  await writeTranscript(session.id, session.fullTranscript);

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
      const client = twilio(accountSid, authToken);
      await client.calls(session.callSid).update({ status: "completed" });
    } catch (err) {
      console.error(`[daemon] Failed to hangup call ${session.id} via Twilio:`, (err as Error).message);
    }
  }

  // Clean up bridge (closes Gemini session + Twilio WS)
  if (session.bridge && session.bridge instanceof MediaStreamsBridge) {
    (session.bridge as MediaStreamsBridge).cleanup();
  }

  session.status = "ended";
  logCallCost(session);
  await finalizeCall(session);
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
  const result = await Promise.race([
    session.preConnectingGemini,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  return result ?? undefined;
}

function handleMediaStreamConnection(ws: import("ws").WebSocket): void {
  console.log(`[media-stream] WebSocket connected — waiting for start event with callId`);

  // Twilio's <Stream> delivers customParameters in the "start" event, not in the URL.
  // We listen for the first message to resolve the session, then set up the bridge.
  let initialized = false;
  let initializing = false;
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
        session.status = "in_progress";

        const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (!apiKey) {
          console.error("[media-stream] GOOGLE_GENERATIVE_AI_API_KEY not set");
          ws.close();
          return;
        }

        const appConfig = await loadAppConfig();
        const systemInstruction = session.systemInstruction ?? "You are a helpful phone assistant.";

        // Use a warm Gemini session if it is ready, or wait very briefly for an
        // in-flight warm-up before falling back to connecting after pickup.
        const preConnected =
          session.preConnectedGemini ??
          await waitForPreconnectedGemini(session, PRECONNECT_PICKUP_WAIT_MS);
        if (preConnected) {
          session.preConnectedGemini = undefined; // consumed
          session.preConnectingGemini = undefined;
        }

        const bridge = new MediaStreamsBridge({
          twilioWs: ws,
          callId,
          session,
          apiKey,
          geminiConfig: appConfig.gemini,
          systemInstruction,
          preConnectedGemini: preConnected,
          initialTwilioMessages: pendingBridgeMessages.splice(0),
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
          const latePreconnect = session.preConnectingGemini;
          // Fallback: connect Gemini now (pre-connect failed or wasn't attempted)
          bridge.connectGemini()
            .then(() => {
              if (!session.waitForUserBeforeGreeting) bridge.sendInitialGreeting();
            })
            .catch((err) => {
              console.error(`[media-stream] Failed to connect Gemini for call ${callId}:`, (err as Error).message);
              bridge.cleanup();
            });
          latePreconnect?.then((lateGemini) => {
            if (lateGemini && session.preConnectedGemini === lateGemini) {
              session.preConnectedGemini = undefined;
              lateGemini.close();
            }
          }).catch(() => undefined);
        }
      }
    } catch {
      // ignore non-JSON or unexpected messages before init
    }
  });

  ws.on("close", () => {
    if (!initialized) {
      console.log("[media-stream] WebSocket closed before initialization");
    }
  });
}

// --- IPC server (Unix domain socket) ---

type IpcMethod =
  | "call.place"
  | "call.listen"
  | "call.status"
  | "call.hangup";

async function handleIpcMessage(msg: {
  method: IpcMethod;
  params: Record<string, unknown>;
}): Promise<object> {
  switch (msg.method) {
    case "call.place":
      return handleCallPlace(msg.params);
    case "call.listen":
      return handleCallListen(msg.params);
    case "call.status":
      return handleCallStatus(msg.params);
    case "call.hangup":
      return handleCallHangup(msg.params);
    default:
      return { error: "unknown_method", method: msg.method };
  }
}

async function handleCallPlace(params: Record<string, unknown>): Promise<object> {
  const to = params.to as string;
  const from = params.from as string;
  const objective = (params.objective as string) || undefined;
  const persona = (params.persona as string) || undefined;
  const hangupWhen = (params.hangupWhen as string) || undefined;
  const maxDuration = (params.maxDuration as number) || undefined;
  const autoHangupAfterFirstOutboundAudioPlayedMs = (params.autoHangupAfterFirstOutboundAudioPlayedMs as number) || undefined;
  const waitForUserBeforeGreeting = params.waitForUserBeforeGreeting === true;
  const experimentalLocalVad = params.experimentalLocalVad === true;
  const enableAmd = params.amd !== false;

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

  const appConfig = await loadAppConfig();

  const id = generateCallId();
  const session = createSession({ id, from, to });

  // G1: Set max duration from flag or config default
  const maxDurationSec = maxDuration ?? appConfig.call.max_duration_seconds;
  session.maxDurationMs = maxDurationSec * 1000;
  session.autoHangupAfterFirstOutboundAudioPlayedMs = autoHangupAfterFirstOutboundAudioPlayedMs;
  session.waitForUserBeforeGreeting = waitForUserBeforeGreeting;
  session.experimentalLocalVad = experimentalLocalVad;

  const sysInstruction = await buildSystemInstruction({
    identity: appConfig.identity,
    persona: persona || appConfig.voice_agent.default_persona,
    objective,
    hangupWhen,
  });
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
    manualActivityDetection: experimentalLocalVad,
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
    onGenerationComplete: () => {},
    onTurnComplete: () => {},
    onInterrupted: () => {},
    onEnd: () => {
      session.preGeneratedGreetingEnded = true;
      session.preGeneratedGreetingEndedAt = isoNow();
      console.log(`[daemon] Pre-connected Gemini session ended before media stream for call ${id}`);
    },
  });

  const preconnectPromise = (async (): Promise<GeminiLiveSession | null> => {
    session.geminiPreconnectStartedAt = isoNow();
    try {
      await geminiSession.connect();
      session.geminiPreconnectConnectedAt = isoNow();
      if (session.status === "ended" || session.mediaStreamStartedAt || session.bridge) {
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
      return null;
    }
  })();
  session.preConnectingGemini = preconnectPromise;

  try {
    const client = twilio(accountSid, authToken);
    session.callCreateStartedAt = isoNow();
    const twilioCall = await client.calls.create({
      to,
      from,
      twiml,
      statusCallback: `${webhookBaseUrl}/call-status/${id}`,
      statusCallbackEvent: ["ringing", "answered", "completed"],
      ...(enableAmd ? {
        machineDetection: "DetectMessageEnd",
        asyncAmd: "true",
        asyncAmdStatusCallback: `${webhookBaseUrl}/call-amd/${id}`,
        asyncAmdStatusCallbackMethod: "POST",
      } : {}),
    });

    session.callSid = twilioCall.sid;
    session.callPlacedAt = isoNow();
    appendEvent(session, { type: "call_placed", ts: session.callPlacedAt, from, to });
    if (session.preConnectedGemini && !session.waitForUserBeforeGreeting) {
      requestPreGeneratedGreeting(session, session.preConnectedGemini);
    }

    resetIdleTimer();
    return {
      id,
      status: "ringing",
      amd: enableAmd,
      wait_for_user_before_greeting: waitForUserBeforeGreeting,
      experimental_local_vad: experimentalLocalVad,
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
      const client = twilio(accountSid, authToken);
      await client.calls(session.callSid).update({ status: "completed" });
    } catch (err) {
      console.error(`[daemon] Failed to hangup call ${id} via Twilio:`, (err as Error).message);
    }
  }

  // Clean up bridge (handles Gemini session close + Twilio WS close)
  if (session.bridge && session.bridge instanceof MediaStreamsBridge) {
    (session.bridge as MediaStreamsBridge).cleanup();
  }

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

// --- Auto-shutdown & call inactivity checks ---

let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const active = listSessions().filter((s) => s.status !== "ended");
    if (active.length === 0) {
      console.log("[daemon] No active calls for 5 minutes — shutting down");
      shutdown();
    } else {
      resetIdleTimer();
    }
  }, IDLE_SHUTDOWN_MS);
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
  if (idleTimer) clearTimeout(idleTimer);
  clearInterval(activityInterval);

  wss.close();
  httpServer.close();
  ipcServer.close();

  cleanup().then(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Start ---

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

  resetIdleTimer();
}

start().catch((err) => {
  console.error("[daemon] Failed to start:", err);
  process.exit(1);
});
