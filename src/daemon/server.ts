import { config } from "dotenv";
config();

import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { writeFile, unlink } from "node:fs/promises";
import { URL } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import { generateCallId, createSession, getSession, getSessionByCallSid, listSessions, sessionEvents, appendTranscriptEntry } from "./sessions.js";
import { appendEvent, writeTranscript } from "../logs/sessionLog.js";

// --- Constants ---

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const PID_FILE = "/tmp/outreach-daemon.pid";
const SOCKET_PATH = "/tmp/outreach-daemon.sock";
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000; // 5 minutes
const CALL_INACTIVITY_MS = 60 * 1000; // 60 seconds

// --- Express app ---

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  const activeSessions = listSessions().filter((s) => s.status !== "ended");
  res.json({ status: "ok", calls: activeSessions.length });
});

app.post("/webhook/voice", (req, res) => {
  const callId = (req.query.callId as string) ?? "";
  const ttsProvider = (req.query.ttsProvider as string) ?? "google";
  const sttProvider = (req.query.sttProvider as string) ?? "google";
  const voice = (req.query.voice as string) ?? "en-US-Journey-O";
  const welcomeGreeting = (req.query.welcomeGreeting as string) ?? "";

  // Derive WebSocket host from request or config
  const webhookUrl = process.env.OUTREACH_WEBHOOK_URL;
  let wsHost: string;
  if (webhookUrl) {
    try {
      wsHost = new URL(webhookUrl).host;
    } catch {
      wsHost = req.headers.host ?? `localhost:${PORT}`;
    }
  } else {
    wsHost = req.headers.host ?? `localhost:${PORT}`;
  }

  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <ConversationRelay url="wss://${wsHost}/conversation-relay?callId=${encodeURIComponent(callId)}"`,
    `      ttsProvider="${escapeXml(ttsProvider)}"`,
    `      sttProvider="${escapeXml(sttProvider)}"`,
    `      voice="${escapeXml(voice)}"`,
    `      dtmfDetection="true"`,
    `      interruptible="true"`,
    `      welcomeGreeting="${escapeXml(welcomeGreeting)}"`,
    `      callId="${escapeXml(callId)}" />`,
    "  </Connect>",
    "</Response>",
  ].join("\n");

  res.type("text/xml").send(twiml);
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
  if (req.url?.startsWith("/conversation-relay")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  // Try to extract callId from URL query params (may not be present — Twilio
  // sends custom attributes in the setup message instead)
  const reqUrl = new URL(req.url ?? "", `http://${req.headers.host}`);
  let callId = reqUrl.searchParams.get("callId") ?? "";
  let session = callId ? getSession(callId) : undefined;

  if (session) {
    session.ws = ws;
    session.lastActivityTime = Date.now();
    console.log(`[conversation-relay] connected for call ${callId}`);
  } else {
    console.log(`[conversation-relay] connected — awaiting setup for callId`);
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        type: string;
        voicePrompt?: string;
        digit?: string;
        callSid?: string;
        customParameters?: Record<string, string>;
        [key: string]: unknown;
      };

      if (session) {
        session.lastActivityTime = Date.now();
      }

      switch (msg.type) {
        case "setup": {
          // Resolve session — try URL param first, then customParameters, then callSid lookup
          if (!session && msg.customParameters?.callId) {
            callId = msg.customParameters.callId;
            session = getSession(callId);
          }
          if (!session && msg.callSid) {
            session = getSessionByCallSid(msg.callSid);
            if (session) callId = session.id;
          }
          if (session) {
            session.ws = ws;
            session.status = "in_progress";
            session.lastActivityTime = Date.now();
            if (msg.callSid) session.callSid = msg.callSid;
          }
          console.log(`[conversation-relay] setup for call ${callId}`, msg);
          break;
        }

        case "prompt":
          if (session && msg.voicePrompt) {
            appendTranscriptEntry(session, { speaker: "remote", text: msg.voicePrompt, ts: Date.now() });
          }
          break;

        case "interrupt":
          if (session) {
            console.log(`[conversation-relay] interrupt on call ${callId}`);
          }
          break;

        case "dtmf":
          if (session && msg.digit) {
            appendTranscriptEntry(session, { speaker: "remote", text: msg.digit, ts: Date.now() });
          }
          break;

        default:
          console.log(`[conversation-relay] unhandled message type: ${msg.type}`);
      }
    } catch {
      console.log("[conversation-relay] non-JSON message:", data.toString());
    }
  });

  ws.on("close", () => {
    console.log(`[conversation-relay] connection closed for call ${callId}`);
    if (session) {
      session.status = "ended";
      session.ws = undefined;
      writeTranscript(session.id, session.fullTranscript).catch((err) => {
        console.error(`[conversation-relay] failed to write transcript for ${callId}:`, err);
      });
    }
  });
});

// --- IPC server (Unix domain socket) ---

type IpcMethod =
  | "call.place"
  | "call.listen"
  | "call.say"
  | "call.dtmf"
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
    case "call.say":
      return handleCallSay(msg.params);
    case "call.dtmf":
      return handleCallDtmf(msg.params);
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
  const ttsProvider = (params.ttsProvider as string) || "ElevenLabs";
  const sttProvider = (params.sttProvider as string) || "Deepgram";
  const voice = (params.voice as string) || "";
  const welcomeGreeting = (params.welcomeGreeting as string) || "";

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const webhookBaseUrl = process.env.OUTREACH_WEBHOOK_URL;

  if (!accountSid || !authToken) {
    return { error: "config_error", message: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set" };
  }
  if (!webhookBaseUrl) {
    return { error: "config_error", message: "OUTREACH_WEBHOOK_URL must be set" };
  }

  const id = generateCallId();
  const session = createSession({ id, from, to });

  try {
    const client = twilio(accountSid, authToken);
    const twilioCall = await client.calls.create({
      to,
      from,
      url: `${webhookBaseUrl}/webhook/voice?callId=${id}&ttsProvider=${encodeURIComponent(ttsProvider)}&sttProvider=${encodeURIComponent(sttProvider)}&voice=${encodeURIComponent(voice)}&welcomeGreeting=${encodeURIComponent(welcomeGreeting)}`,
    });

    session.callSid = twilioCall.sid;

    // Log call.started event
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
    if (currentLen > session.lastListenIndex) {
      // New entries already available
    } else {
      // Wait for new transcript entries or timeout
      await new Promise<void>((resolve) => {
        const eventName = `transcript:${id}`;
        let timer: ReturnType<typeof setTimeout>;

        const onTranscript = () => {
          clearTimeout(timer);
          resolve();
        };

        timer = setTimeout(() => {
          sessionEvents.removeListener(eventName, onTranscript);
          resolve();
        }, timeout);

        sessionEvents.once(eventName, onTranscript);
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

async function handleCallSay(params: Record<string, unknown>): Promise<object> {
  const id = params.id as string;
  const message = params.message as string;
  const interrupt = params.interrupt as boolean ?? false;

  const session = getSession(id);
  if (!session) {
    return { error: "session_not_found", message: `No session with id ${id}` };
  }
  if (session.status !== "in_progress" || !session.ws) {
    return { error: "call_not_active", message: "Call is not active or WebSocket not connected" };
  }

  if (interrupt) {
    session.ws.send(JSON.stringify({ type: "clear" }));
  }

  session.ws.send(JSON.stringify({ type: "text", token: message, last: true }));
  session.lastActivityTime = Date.now();
  appendTranscriptEntry(session, { speaker: "local", text: message, ts: Date.now() });

  return { id, status: "in_progress", spoke: true };
}

async function handleCallDtmf(params: Record<string, unknown>): Promise<object> {
  const id = params.id as string;
  const keys = params.keys as string;

  const session = getSession(id);
  if (!session) {
    return { error: "session_not_found", message: `No session with id ${id}` };
  }
  if (session.status !== "in_progress") {
    return { error: "call_not_active", message: "Call is not active" };
  }

  // Send DTMF via ConversationRelay WebSocket if available,
  // otherwise fall back to Twilio REST API with TwiML redirect
  if (session.ws) {
    // ConversationRelay supports sending DTMF via a "dtmf" message
    session.ws.send(JSON.stringify({ type: "dtmf", digits: keys }));
    session.lastActivityTime = Date.now();
    return { id, status: "in_progress", sent: keys };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken || !session.callSid) {
    return { error: "config_error", message: "Missing Twilio credentials or call SID" };
  }

  try {
    const client = twilio(accountSid, authToken);
    // Use TwiML to play DTMF tones on the call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${escapeXml(keys)}"/><Connect><ConversationRelay url="wss://${process.env.OUTREACH_WEBHOOK_URL ? new URL(process.env.OUTREACH_WEBHOOK_URL).host : "localhost:" + PORT}/conversation-relay" callId="${escapeXml(id)}" /></Connect></Response>`;
    await client.calls(session.callSid).update({ twiml });
    session.lastActivityTime = Date.now();
    return { id, status: "in_progress", sent: keys };
  } catch (err) {
    return { error: "twilio_error", message: (err as Error).message };
  }
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

  // End via Twilio REST API
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

  // Close WebSocket
  if (session.ws) {
    session.ws.close();
    session.ws = undefined;
  }

  session.status = "ended";

  // Write transcript
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
    if (
      session.status !== "ended" &&
      now - session.lastActivityTime > CALL_INACTIVITY_MS
    ) {
      console.log(
        `[daemon] Call ${session.id} inactive for 60s — auto-hangup`,
      );
      session.status = "ended";
      if (session.ws) {
        session.ws.close();
        session.ws = undefined;
      }
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
