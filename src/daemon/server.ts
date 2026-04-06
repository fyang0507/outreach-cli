import { config } from "dotenv";
config({ quiet: true });

import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { writeFile, unlink } from "node:fs/promises";
import express from "express";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import { generateCallId, createSession, getSession, listSessions, sessionEvents, appendTranscriptEntry } from "./sessions.js";
import type { CallSession } from "./sessions.js";
import { appendEvent, writeTranscript } from "../logs/sessionLog.js";
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

// --- Express app ---

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  const activeSessions = listSessions().filter((s) => s.status !== "ended");
  res.json({ status: "ok", calls: activeSessions.length });
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

async function forceHangup(session: CallSession, reason: string): Promise<void> {
  if (session.status === "ended") return;

  console.log(`[daemon] ${reason}`);

  // Append transcript entry for the forced hangup
  appendTranscriptEntry(session, {
    speaker: "local",
    text: `[Call ended: ${reason}]`,
    ts: Date.now(),
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
  await writeTranscript(session.id, session.fullTranscript);
}

function handleMediaStreamConnection(ws: import("ws").WebSocket): void {
  console.log(`[media-stream] WebSocket connected — waiting for start event with callId`);

  // Twilio's <Stream> delivers customParameters in the "start" event, not in the URL.
  // We listen for the first message to resolve the session, then set up the bridge.
  let initialized = false;

  ws.on("message", async (data) => {
    if (initialized) return; // Bridge handles subsequent messages

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
        const callId = msg.start?.customParameters?.callId ?? "";
        const session = callId ? getSession(callId) : undefined;

        if (!session) {
          console.error(`[media-stream] No session found for callId=${callId}`);
          ws.close();
          return;
        }

        console.log(`[media-stream] Start event received for call ${callId}`);
        session.ws = ws;
        session.lastActivityTime = Date.now();
        if (msg.start?.streamSid) session.streamSid = msg.start.streamSid;
        if (msg.start?.callSid) session.callSid = msg.start.callSid;
        session.status = "in_progress";

        const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (!apiKey) {
          console.error("[media-stream] GOOGLE_GENERATIVE_AI_API_KEY not set");
          ws.close();
          return;
        }

        const appConfig = await loadAppConfig();
        const systemInstruction = session.systemInstruction ?? "You are a helpful phone assistant.";

        // Use pre-connected Gemini session if available (issue #9)
        const preConnected = session.preConnectedGemini ?? undefined;
        session.preConnectedGemini = undefined; // consumed

        const bridge = new MediaStreamsBridge({
          twilioWs: ws,
          callId,
          session,
          apiKey,
          geminiConfig: appConfig.gemini,
          systemInstruction,
          preConnectedGemini: preConnected,
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
        } else {
          // Fallback: connect Gemini now (pre-connect failed or wasn't attempted)
          bridge.connectGemini().catch((err) => {
            console.error(`[media-stream] Failed to connect Gemini for call ${callId}:`, (err as Error).message);
            bridge.cleanup();
          });
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
  const campaign = (params.campaign as string) || undefined;
  const welcomeGreeting = (params.welcomeGreeting as string) || "";
  const objective = (params.objective as string) || undefined;
  const persona = (params.persona as string) || undefined;
  const hangupWhen = (params.hangupWhen as string) || undefined;
  const maxDuration = (params.maxDuration as number) || undefined;

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
    return { error: "config_error", message: "OUTREACH_WEBHOOK_URL must be set (or run 'outreach init')" };
  }

  const appConfig = await loadAppConfig();

  const id = generateCallId();
  const session = createSession({ id, from, to });

  // G1: Set max duration from flag or config default
  const maxDurationSec = maxDuration ?? appConfig.call.max_duration_seconds;
  session.maxDurationMs = maxDurationSec * 1000;

  const sysInstruction = await buildSystemInstruction({
    persona: persona || appConfig.voice_agent.default_persona,
    objective,
    hangupWhen,
    welcomeGreeting,
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
    // No-op callbacks during pre-connect — bridge will rebind when media stream connects
    onAudio: () => {},
    onTranscript: () => {},
    onToolCall: () => {},
    onEnd: () => {
      console.log(`[daemon] Pre-connected Gemini session ended before media stream for call ${id}`);
    },
  });

  try {
    await geminiSession.connect();
    session.preConnectedGemini = geminiSession;
    console.log(`[daemon] Gemini pre-connected for call ${id}`);
  } catch (err) {
    console.error(`[daemon] Gemini pre-connect failed for call ${id}:`, (err as Error).message);
    // Fall back to connecting after media stream starts — don't block the call
  }

  try {
    const client = twilio(accountSid, authToken);
    const twilioCall = await client.calls.create({
      to,
      from,
      twiml,
    });

    session.callSid = twilioCall.sid;

    const campaignId = campaign || id;
    await appendEvent(campaignId, {
      type: "call.started",
      callId: id,
      callSid: twilioCall.sid,
      from,
      to,
      ts: Date.now(),
    });

    resetIdleTimer();
    return { id, status: "ringing" };
  } catch (err) {
    session.status = "ended";
    // Clean up pre-connected Gemini if Twilio call fails
    geminiSession.close();
    return { error: "twilio_error", message: (err as Error).message };
  }
}

async function handleCallListen(params: Record<string, unknown>): Promise<object> {
  const id = params.id as string;
  const wait = params.wait as boolean ?? false;
  const timeout = (params.timeout as number) ?? 30000;

  const session = getSession(id);
  if (!session) {
    return { error: "session_not_found", message: `No session with id ${id}` };
  }

  if (wait) {
    // Check if there are already new entries
    const currentLen = session.transcriptBuffer.length;
    if (currentLen <= session.lastListenIndex) {
      // Wait for new transcript entries or timeout
      // Use a debounce: after first event, wait 300ms for more chunks
      // before returning, so we collect a full utterance
      await new Promise<void>((resolve) => {
        const eventName = `transcript:${id}`;
        let mainTimer: ReturnType<typeof setTimeout>;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const finish = () => {
          clearTimeout(mainTimer);
          if (debounceTimer) clearTimeout(debounceTimer);
          sessionEvents.removeListener(eventName, onTranscript);
          resolve();
        };

        const onTranscript = () => {
          // Got a chunk — debounce: wait 300ms for more before resolving
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(finish, 300);
        };

        mainTimer = setTimeout(() => {
          sessionEvents.removeListener(eventName, onTranscript);
          if (debounceTimer) clearTimeout(debounceTimer);
          resolve();
        }, timeout);

        sessionEvents.on(eventName, onTranscript);
      });
    }
  }

  const newEntries = session.transcriptBuffer.slice(session.lastListenIndex);
  session.lastListenIndex = session.transcriptBuffer.length;
  session.lastActivityTime = Date.now();
  const silenceMs = Date.now() - session.lastSpeechTime;

  return {
    id,
    status: session.status,
    transcript: newEntries,
    silence_ms: silenceMs,
  };
}

async function handleCallStatus(params: Record<string, unknown>): Promise<object> {
  const id = params.id as string;

  const session = getSession(id);
  if (!session) {
    return { error: "session_not_found", message: `No session with id ${id}` };
  }

  const statusToPhase: Record<string, string> = {
    ringing: "ringing",
    in_progress: "answered",
    ended: "hungup",
  };

  return {
    id,
    status: session.status,
    phase: statusToPhase[session.status] ?? session.status,
    duration_sec: Math.floor((Date.now() - session.startTime) / 1000),
    from: session.from,
    to: session.to,
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

  const durationSec = Math.floor((Date.now() - session.startTime) / 1000);

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
  await writeTranscript(id, session.fullTranscript);

  return { id, status: "ended", duration_sec: durationSec };
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
