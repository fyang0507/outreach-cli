import type { WebSocket } from "ws";
import twilio from "twilio";
import { GeminiLiveSession } from "../audio/geminiLive.js";
import { twilioToGemini, geminiToTwilio } from "../audio/transcode.js";
import { appendTranscriptEntry, sessionEvents, type CallSession } from "./sessions.js";
import { writeTranscript } from "../logs/sessionLog.js";

export interface MediaStreamsBridgeOptions {
  twilioWs: WebSocket;
  callId: string;
  session: CallSession;
  apiKey: string;
  model: string;
  systemInstruction: string;
  voiceName: string;
}

export class MediaStreamsBridge {
  private twilioWs: WebSocket;
  private gemini: GeminiLiveSession;
  private callId: string;
  private session: CallSession;
  private cleaned = false;

  constructor(opts: MediaStreamsBridgeOptions) {
    this.twilioWs = opts.twilioWs;
    this.callId = opts.callId;
    this.session = opts.session;

    this.gemini = new GeminiLiveSession({
      apiKey: opts.apiKey,
      model: opts.model,
      systemInstruction: opts.systemInstruction,
      voiceName: opts.voiceName,
      onAudio: (base64Pcm24k: string) => {
        if (this.cleaned || !this.session.streamSid) return;
        const mulawPayload = geminiToTwilio(base64Pcm24k);
        try {
          this.twilioWs.send(JSON.stringify({
            event: "media",
            streamSid: this.session.streamSid,
            media: { payload: mulawPayload },
          }));
        } catch {
          // Twilio WS may have closed
        }
      },
      onTranscript: (speaker: "remote" | "local", text: string) => {
        if (this.cleaned) return;
        appendTranscriptEntry(this.session, { speaker, text, ts: Date.now() });
      },
      onToolCall: (name: string, args: Record<string, unknown>, id: string) => {
        this.handleToolCall(name, args, id);
      },
      onEnd: () => {
        console.log(`[media-bridge] Gemini session ended for call ${this.callId}`);
        this.cleanup();
      },
    });

    // Wire up Twilio WS messages
    this.twilioWs.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          event: string;
          start?: { streamSid: string; callSid: string };
          media?: { payload: string };
          [key: string]: unknown;
        };
        this.handleTwilioMessage(msg);
      } catch {
        console.log("[media-bridge] non-JSON message from Twilio");
      }
    });

    this.twilioWs.on("close", () => {
      console.log(`[media-bridge] Twilio WS closed for call ${this.callId}`);
      this.cleanup();
    });

    this.twilioWs.on("error", (err) => {
      console.error(`[media-bridge] Twilio WS error for call ${this.callId}:`, err.message);
    });
  }

  async connectGemini(): Promise<void> {
    await this.gemini.connect();
  }

  private handleTwilioMessage(msg: {
    event: string;
    start?: { streamSid: string; callSid: string };
    media?: { payload: string };
    [key: string]: unknown;
  }): void {
    switch (msg.event) {
      case "start": {
        if (msg.start) {
          this.session.streamSid = msg.start.streamSid;
          if (msg.start.callSid) {
            this.session.callSid = msg.start.callSid;
          }
          this.session.status = "in_progress";
          this.session.lastActivityTime = Date.now();
          console.log(`[media-bridge] Stream started: streamSid=${msg.start.streamSid}, callSid=${msg.start.callSid}`);
        }
        break;
      }
      case "media": {
        if (msg.media?.payload) {
          this.session.lastActivityTime = Date.now();
          const pcm16k = twilioToGemini(msg.media.payload);
          this.gemini.sendAudio(pcm16k);
        }
        break;
      }
      case "stop": {
        console.log(`[media-bridge] Twilio stream stopped for call ${this.callId}`);
        this.cleanup();
        break;
      }
      default:
        // connected, mark, etc. — ignore
        break;
    }
  }

  private handleToolCall(name: string, args: Record<string, unknown>, id: string): void {
    switch (name) {
      case "send_dtmf":
        this.handleSendDtmf(args, id);
        break;
      case "end_call":
        this.handleEndCall(args, id);
        break;
      default:
        console.log(`[media-bridge] Unknown tool call: ${name}`);
        this.gemini.sendToolResponse(id, name, { error: `Unknown tool: ${name}` });
    }
  }

  private handleSendDtmf(args: Record<string, unknown>, id: string): void {
    const digits = args.digits as string;
    if (!digits) {
      this.gemini.sendToolResponse(id, "send_dtmf", { error: "No digits provided" });
      return;
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const callSid = this.session.callSid;
    const webhookUrl = process.env.OUTREACH_WEBHOOK_URL;

    if (!accountSid || !authToken || !callSid) {
      console.error("[media-bridge] Missing Twilio credentials or callSid for DTMF");
      this.gemini.sendToolResponse(id, "send_dtmf", { error: "Missing credentials" });
      return;
    }

    // Send DTMF by updating the call with TwiML that plays digits then reconnects the stream
    let wsHost = "localhost:3001";
    if (webhookUrl) {
      try { wsHost = new URL(webhookUrl).host; } catch { /* use default */ }
    }
    const twiml = `<Response><Play digits="${digits}"/><Connect><Stream url="wss://${wsHost}/media-stream"><Parameter name="callId" value="${this.callId}" /></Stream></Connect></Response>`;

    const client = twilio(accountSid, authToken);
    client.calls(callSid).update({ twiml })
      .then(() => {
        console.log(`[media-bridge] Sent DTMF: ${digits}`);
        appendTranscriptEntry(this.session, { speaker: "local", text: `[DTMF: ${digits}]`, ts: Date.now() });
        this.gemini.sendToolResponse(id, "send_dtmf", { success: true, digits });
      })
      .catch((err: Error) => {
        console.error(`[media-bridge] DTMF send failed:`, err.message);
        this.gemini.sendToolResponse(id, "send_dtmf", { error: err.message });
      });
  }

  private handleEndCall(args: Record<string, unknown>, id: string): void {
    const reason = (args.reason as string) || "Call ended by assistant";
    console.log(`[media-bridge] end_call tool invoked: ${reason}`);

    appendTranscriptEntry(this.session, { speaker: "local", text: `[Call ended: ${reason}]`, ts: Date.now() });

    // Respond to Gemini before closing
    this.gemini.sendToolResponse(id, "end_call", { success: true, reason });

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const callSid = this.session.callSid;

    if (accountSid && authToken && callSid) {
      const client = twilio(accountSid, authToken);
      client.calls(callSid).update({ status: "completed" })
        .then(() => {
          console.log(`[media-bridge] Call ${this.callId} hung up via Twilio`);
        })
        .catch((err) => {
          console.error(`[media-bridge] Failed to hangup call:`, (err as Error).message);
        })
        .finally(() => {
          this.cleanup();
        });
    } else {
      this.cleanup();
    }
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;

    console.log(`[media-bridge] Cleaning up call ${this.callId}`);

    // Close Gemini session
    this.gemini.close();

    // Close Twilio WS
    try {
      this.twilioWs.close();
    } catch {
      // ignore
    }

    // Mark session ended
    this.session.status = "ended";
    this.session.ws = undefined;
    this.session.bridge = undefined;

    // Write transcript
    writeTranscript(this.callId, this.session.fullTranscript).catch((err) => {
      console.error(`[media-bridge] Failed to write transcript for ${this.callId}:`, err);
    });

    // Emit event to unblock any waiting listen commands
    sessionEvents.emit(`transcript:${this.callId}`);
  }
}
