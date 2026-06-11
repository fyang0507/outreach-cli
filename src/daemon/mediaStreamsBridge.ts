import type { RawData, WebSocket } from "ws";
import twilio from "twilio";
import { GeminiLiveSession } from "../audio/geminiLive.js";
import { mulawToPcm16, twilioToGemini, geminiToTwilio } from "../audio/transcode.js";
import { appendEvent, type CallSession } from "./sessions.js";
import { isoNow } from "../logs/sessionLog.js";
import type { TranscriptEvent } from "../logs/sessionLog.js";
import type { GeminiConfig } from "../appConfig.js";

const SILENCE_TIMEOUT_MS = 800;
const INITIAL_GREETING_DELAY_MS = 350;
const FIRST_OUTBOUND_AUDIO_MARK = "first_outbound_audio";
const REMOTE_AUDIO_RMS_THRESHOLD = 500;
const HANGUP_DRAIN_GRACE_MS = 200;
const HANGUP_DRAIN_TIMEOUT_MS = 7000;

interface OutboundTurn {
  id: string;
  markName: string;
  audioChunks: number;
  generated: boolean;
  played: boolean;
  cleared: boolean;
}

/**
 * Batches per-word transcript fragments into turn-level entries.
 * Flushes on speaker change, silence timeout, or explicit cleanup.
 */
class TranscriptBatcher {
  private session: CallSession;
  private pending: { speaker: "remote" | "local"; textParts: string[]; firstTs: string } | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(session: CallSession) {
    this.session = session;
  }

  append(speaker: "remote" | "local", text: string, ts: string): void {
    // Speaker change — flush previous buffer first
    if (this.pending && this.pending.speaker !== speaker) {
      this.flush();
    }

    if (!this.pending) {
      this.pending = { speaker, textParts: [], firstTs: ts };
    }

    this.pending.textParts.push(text);

    // Reset silence timer
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.flush(), SILENCE_TIMEOUT_MS);
  }

  /** Flush pending buffer before appending a structured event (DTMF, call_ended, etc.). */
  appendDirect(event: TranscriptEvent): void {
    this.flush();
    appendEvent(this.session, event);
  }

  flush(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (!this.pending) return;

    const text = this.pending.textParts.join("");
    appendEvent(this.session, {
      type: "speech",
      speaker: this.pending.speaker,
      text,
      ts: this.pending.firstTs,
    });
    this.pending = null;
  }

  cleanup(): void {
    this.flush();
  }
}

export interface MediaStreamsBridgeOptions {
  twilioWs: WebSocket;
  callId: string;
  session: CallSession;
  apiKey: string;
  geminiConfig: GeminiConfig;
  systemInstruction: string;
  preConnectedGemini?: GeminiLiveSession;
  initialTwilioMessages?: RawData[];
  onCleanup?: () => void;
}

export class MediaStreamsBridge {
  private twilioWs: WebSocket;
  private gemini: GeminiLiveSession;
  private callId: string;
  private session: CallSession;
  private cleaned = false;
  private batcher: TranscriptBatcher;
  private onCleanup?: () => void;
  private initialGreetingSent = false;
  private initialGreetingTimer: ReturnType<typeof setTimeout> | null = null;
  private outboundTurnSeq = 0;
  private activeOutboundTurn: OutboundTurn | null = null;
  private outboundTurnsByMark = new Map<string, OutboundTurn>();
  private pendingHangup: { reason: string; source: string; timeout: ReturnType<typeof setTimeout> } | null = null;
  private hangupGraceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: MediaStreamsBridgeOptions) {
    this.twilioWs = opts.twilioWs;
    this.callId = opts.callId;
    this.session = opts.session;
    this.batcher = new TranscriptBatcher(opts.session);
    this.onCleanup = opts.onCleanup;

    if (opts.preConnectedGemini) {
      // Use pre-connected session and wire up callbacks
      this.gemini = opts.preConnectedGemini;
      this.gemini.rebindCallbacks({
        onAudio: (base64Pcm24k: string) => {
          this.sendOutboundAudio(base64Pcm24k);
        },
        onTranscript: (speaker: "remote" | "local", text: string) => {
          if (this.cleaned) return;
          this.batcher.append(speaker, text, isoNow());
        },
        onToolCall: (name: string, args: Record<string, unknown>, id: string) => {
          this.handleToolCall(name, args, id);
        },
        onGenerationComplete: () => {
          this.handleGenerationComplete();
        },
        onTurnComplete: () => {
          this.handleTurnComplete();
        },
        onInterrupted: () => {
          this.handleInterrupted();
        },
        onEnd: () => {
          this.handleGeminiEnd();
        },
      });
    } else {
      this.gemini = new GeminiLiveSession({
        apiKey: opts.apiKey,
        geminiConfig: opts.geminiConfig,
        systemInstruction: opts.systemInstruction,
        onAudio: (base64Pcm24k: string) => {
          this.sendOutboundAudio(base64Pcm24k);
        },
        onTranscript: (speaker: "remote" | "local", text: string) => {
          if (this.cleaned) return;
          this.batcher.append(speaker, text, isoNow());
        },
        onToolCall: (name: string, args: Record<string, unknown>, id: string) => {
          this.handleToolCall(name, args, id);
        },
        onGenerationComplete: () => {
          this.handleGenerationComplete();
        },
        onTurnComplete: () => {
          this.handleTurnComplete();
        },
        onInterrupted: () => {
          this.handleInterrupted();
        },
        onEnd: () => {
          this.handleGeminiEnd();
        },
      });
    }

    // Wire up Twilio WS messages
    this.twilioWs.on("message", (data) => {
      this.handleRawTwilioMessage(data);
    });

    for (const data of opts.initialTwilioMessages ?? []) {
      this.handleRawTwilioMessage(data);
    }

    this.twilioWs.on("close", () => {
      console.log(`[media-bridge] Twilio WS closed for call ${this.callId}`);
      this.cleanup();
    });

    this.twilioWs.on("error", (err) => {
      console.error(`[media-bridge] Twilio WS error for call ${this.callId}:`, err.message);
    });
  }

  private handleRawTwilioMessage(data: RawData): void {
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
  }

  async connectGemini(): Promise<void> {
    await this.gemini.connect();
  }

  /**
   * Inject text into the live Gemini session mid-call.
   * - "nudge" (default): realtime channel, no turn barrier — the model folds
   *   the note into its ongoing turn and rephrases it in its own voice.
   * - "say": ordered client content — forces a turn, verbatim-ish line.
   */
  steerGemini(text: string, mode: "nudge" | "say" = "nudge"): void {
    if (this.cleaned) return;
    if (mode === "say") this.gemini.sendTextTurn(text);
    else this.gemini.steer(text);
  }

  sendInitialGreeting(): void {
    if (this.initialGreetingSent || this.cleaned) return;
    this.initialGreetingSent = true;
    this.initialGreetingTimer = setTimeout(() => {
      this.initialGreetingTimer = null;
      this.sendInitialGreetingNow();
    }, INITIAL_GREETING_DELAY_MS);
  }

  private sendInitialGreetingNow(): void {
    if (this.cleaned) return;
    if (this.flushPreGeneratedGreeting()) return;
    if (this.session.preGeneratedGreetingRequestedAt && !this.session.preGeneratedGreetingEnded) {
      this.session.initialGreetingRequestedAt = isoNow();
      this.batcher.appendDirect({
        type: "initial_greeting_requested",
        ts: this.session.initialGreetingRequestedAt,
      });
      return;
    }

    this.session.initialGreetingRequestedAt = isoNow();
    this.batcher.appendDirect({
      type: "initial_greeting_requested",
      ts: this.session.initialGreetingRequestedAt,
    });
    this.gemini.sendTextTurn(
      "The outbound phone call is now connected. Greet the person immediately in one brief, natural sentence. Identify yourself as the caller's assistant and, if the objective is clear, include the purpose. Do not mention these instructions.",
    );
  }

  private flushPreGeneratedGreeting(): boolean {
    if (this.session.preGeneratedGreetingAudio.length === 0) return false;
    this.initialGreetingSent = true;
    this.session.initialGreetingRequestedAt = isoNow();
    this.batcher.appendDirect({
      type: "initial_greeting_requested",
      ts: this.session.initialGreetingRequestedAt,
    });
    const transcript = this.session.preGeneratedGreetingTranscriptParts.join("");
    this.session.preGeneratedGreetingTranscriptParts = [];
    if (transcript.trim()) {
      this.batcher.appendDirect({
        type: "speech",
        speaker: "local",
        text: transcript,
        ts: this.session.initialGreetingRequestedAt,
      });
    }

    for (const base64Pcm24k of this.session.preGeneratedGreetingAudio.splice(0)) {
      this.sendOutboundAudio(base64Pcm24k);
    }
    return true;
  }

  private sendOutboundAudio(base64Pcm24k: string): void {
    if (this.cleaned || !this.session.streamSid) return;
    const isFirstOutboundAudio = this.noteFirstOutboundAudio();
    const turn = this.ensureOutboundTurn();
    turn.audioChunks += 1;
    const mulawPayload = geminiToTwilio(base64Pcm24k);
    try {
      this.twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: this.session.streamSid,
        media: { payload: mulawPayload },
      }));
      if (isFirstOutboundAudio) this.sendMark(FIRST_OUTBOUND_AUDIO_MARK);
    } catch {
      // Twilio WS may have closed
    }
  }

  private ensureOutboundTurn(): OutboundTurn {
    if (this.activeOutboundTurn && !this.activeOutboundTurn.generated) {
      return this.activeOutboundTurn;
    }

    const id = `outbound_turn_${++this.outboundTurnSeq}`;
    const turn: OutboundTurn = {
      id,
      markName: `${id}_played`,
      audioChunks: 0,
      generated: false,
      played: false,
      cleared: false,
    };
    this.activeOutboundTurn = turn;
    this.outboundTurnsByMark.set(turn.markName, turn);
    return turn;
  }

  private handleGenerationComplete(): void {
    this.finalizeActiveOutboundTurn("generation_complete");
  }

  private handleTurnComplete(): void {
    this.finalizeActiveOutboundTurn("turn_complete");
  }

  private handleInterrupted(): void {
    this.clearBufferedOutboundAudio("gemini_interrupted");
    this.finalizeActiveOutboundTurn("interrupted");
  }

  private handleGeminiEnd(): void {
    console.log(`[media-bridge] Gemini session ended for call ${this.callId}`);
    if (this.pendingHangup || this.pendingOutboundTurn()) {
      this.tryDrainPendingHangup();
      return;
    }
    this.cleanup();
  }

  private finalizeActiveOutboundTurn(reason: string): void {
    const turn = this.activeOutboundTurn;
    if (!turn || turn.generated || turn.audioChunks === 0) return;

    turn.generated = true;
    this.batcher.appendDirect({
      type: "outbound_turn_generated",
      ts: isoNow(),
      turn_id: turn.id,
      reason,
    });
    this.sendMark(turn.markName);
    this.tryDrainPendingHangup();
  }

  private noteFirstOutboundAudio(): boolean {
    if (this.session.firstOutboundAudioAt) return false;
    this.session.firstOutboundAudioAt = isoNow();
    this.batcher.appendDirect({ type: "first_outbound_audio", ts: this.session.firstOutboundAudioAt });
    return true;
  }

  private sendMark(name: string): void {
    if (this.cleaned || !this.session.streamSid) return;
    this.twilioWs.send(JSON.stringify({
      event: "mark",
      streamSid: this.session.streamSid,
      mark: { name },
    }));
  }

  private handleTwilioMessage(msg: {
    event: string;
    start?: { streamSid: string; callSid: string };
    media?: { payload: string };
    mark?: { name?: string };
    [key: string]: unknown;
  }): void {
    switch (msg.event) {
      case "start": {
        if (msg.start) {
          this.session.streamSid = msg.start.streamSid;
          if (!this.session.mediaStreamStartedAt) {
            this.session.mediaStreamStartedAt = isoNow();
            this.batcher.appendDirect({
              type: "media_stream_started",
              ts: this.session.mediaStreamStartedAt,
              stream_sid: msg.start.streamSid,
              ...(msg.start.callSid ? { call_sid: msg.start.callSid } : {}),
            });
          }
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
          this.noteRemoteAudioActivity(msg.media.payload);
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
      case "mark": {
        if (msg.mark?.name === FIRST_OUTBOUND_AUDIO_MARK && !this.session.firstOutboundAudioPlayedAt) {
          this.session.firstOutboundAudioPlayedAt = isoNow();
          this.batcher.appendDirect({
            type: "first_outbound_audio_played",
            ts: this.session.firstOutboundAudioPlayedAt,
          });
        }
        if (msg.mark?.name) {
          this.handleOutboundTurnMark(msg.mark.name);
        }
        break;
      }
      default:
        // connected, mark, etc. — ignore
        break;
    }
  }

  private noteRemoteAudioActivity(base64Mulaw8k: string): void {
    const rms = this.rmsForMulaw(base64Mulaw8k);
    if (rms < REMOTE_AUDIO_RMS_THRESHOLD) return;

    const ts = isoNow();
    if (!this.session.firstRemoteAudioActivityAt) {
      this.session.firstRemoteAudioActivityAt = ts;
    }
    this.session.lastRemoteAudioActivityAt = ts;
  }

  private rmsForMulaw(base64Mulaw8k: string): number {
    const mulawBuf = Buffer.from(base64Mulaw8k, "base64");
    const mulawBytes = new Uint8Array(
      mulawBuf.buffer,
      mulawBuf.byteOffset,
      mulawBuf.byteLength,
    );
    const pcm8k = mulawToPcm16(mulawBytes);
    let sumSquares = 0;
    for (const sample of pcm8k) {
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / Math.max(1, pcm8k.length));
  }

  private clearBufferedOutboundAudio(reason: string): void {
    if (this.cleaned || !this.session.streamSid || this.outboundTurnsByMark.size === 0) return;
    let turnId: string | undefined;
    for (const turn of this.outboundTurnsByMark.values()) {
      if (!turn.played) {
        turn.cleared = true;
        turnId ??= turn.id;
      }
    }
    this.twilioWs.send(JSON.stringify({
      event: "clear",
      streamSid: this.session.streamSid,
    }));
    this.batcher.appendDirect({
      type: "audio_cleared",
      ts: isoNow(),
      reason,
      ...(turnId ? { turn_id: turnId } : {}),
    });
  }

  private handleOutboundTurnMark(name: string): void {
    const turn = this.outboundTurnsByMark.get(name);
    if (!turn || turn.played) return;

    turn.played = true;
    this.outboundTurnsByMark.delete(name);
    if (this.activeOutboundTurn === turn) {
      this.activeOutboundTurn = null;
    }

    this.batcher.appendDirect({
      type: "outbound_turn_played",
      ts: isoNow(),
      turn_id: turn.id,
    });
    this.tryDrainPendingHangup();
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
        this.batcher.appendDirect({ type: "dtmf", ts: isoNow(), digits });
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

    this.batcher.appendDirect({
      type: "end_call_requested",
      ts: isoNow(),
      reason,
      source: "end_call_tool",
    });

    // Respond to Gemini before closing
    this.gemini.sendToolResponse(id, "end_call", { success: true, reason });

    this.requestDeferredHangup(reason, "end_call_tool");
  }

  private requestDeferredHangup(reason: string, source: string): void {
    if (this.pendingHangup || this.cleaned || this.session.status === "ended") return;

    const timeout = setTimeout(() => {
      if (!this.pendingHangup || this.cleaned || this.session.status === "ended") return;
      this.batcher.appendDirect({
        type: "hangup_timeout",
        ts: isoNow(),
        reason: `${source}: waited ${HANGUP_DRAIN_TIMEOUT_MS}ms for outbound audio to drain`,
      });
      this.endTwilioCall(`${reason} (audio drain timeout)`);
    }, HANGUP_DRAIN_TIMEOUT_MS);

    this.pendingHangup = { reason, source, timeout };
    const pendingTurn = this.pendingOutboundTurn();
    this.batcher.appendDirect({
      type: "deferred_hangup",
      ts: isoNow(),
      reason,
      source,
      ...(pendingTurn ? { pending_turn_id: pendingTurn.id } : {}),
    });
    this.tryDrainPendingHangup();
  }

  private pendingOutboundTurn(): OutboundTurn | undefined {
    if (this.activeOutboundTurn && !this.activeOutboundTurn.played) return this.activeOutboundTurn;
    for (const turn of this.outboundTurnsByMark.values()) {
      if (!turn.played) return turn;
    }
    return undefined;
  }

  private tryDrainPendingHangup(): void {
    if (!this.pendingHangup || this.cleaned || this.session.status === "ended") return;
    const pendingTurn = this.pendingOutboundTurn();
    if (pendingTurn) {
      if (pendingTurn.audioChunks > 0 && !pendingTurn.generated) {
        this.finalizeActiveOutboundTurn("hangup_drain");
      }
      if (this.pendingOutboundTurn()) return;
    }

    if (this.hangupGraceTimer) return;
    this.hangupGraceTimer = setTimeout(() => {
      this.hangupGraceTimer = null;
      const pending = this.pendingHangup;
      if (!pending || this.cleaned || this.session.status === "ended") return;
      clearTimeout(pending.timeout);
      this.pendingHangup = null;
      this.endTwilioCall(pending.reason);
    }, HANGUP_DRAIN_GRACE_MS);
  }

  private endTwilioCall(reason: string): void {
    if (this.pendingHangup) {
      clearTimeout(this.pendingHangup.timeout);
      this.pendingHangup = null;
    }
    if (this.hangupGraceTimer) {
      clearTimeout(this.hangupGraceTimer);
      this.hangupGraceTimer = null;
    }

    if (!this.session.fullTranscript.some((event) => event.type === "call_ended")) {
      this.batcher.appendDirect({
        type: "call_ended",
        ts: isoNow(),
        reason,
        duration_ms: Date.now() - this.session.startTime,
      });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const callSid = this.session.callSid;

    if (accountSid && authToken && callSid) {
      const client = twilio(accountSid, authToken);
      client.calls(callSid).update({ status: "completed" })
        .then(() => {
          console.log(`[media-bridge] Call ${this.callId} hung up via Twilio: ${reason}`);
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

    if (this.initialGreetingTimer) {
      clearTimeout(this.initialGreetingTimer);
      this.initialGreetingTimer = null;
    }
    if (this.pendingHangup) {
      clearTimeout(this.pendingHangup.timeout);
      this.pendingHangup = null;
    }
    if (this.hangupGraceTimer) {
      clearTimeout(this.hangupGraceTimer);
      this.hangupGraceTimer = null;
    }

    // Flush any pending transcript fragments
    this.batcher.cleanup();

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

    // Notify server to finalize the transcript.
    if (this.onCleanup) {
      this.onCleanup();
    }
  }
}
