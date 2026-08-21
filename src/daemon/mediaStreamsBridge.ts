import type { RawData, WebSocket } from "ws";
import twilio from "twilio";
import { GeminiLiveSession } from "../audio/geminiLive.js";
import { mulawToPcm16, twilioToGemini, geminiToTwilio } from "../audio/transcode.js";
import { appendEvent, type CallSession } from "./sessions.js";
import { isoNow } from "../logs/sessionLog.js";
import type { TranscriptEvent, SpeechFlushReason } from "../logs/sessionLog.js";
import type { GeminiConfig } from "../appConfig.js";

const INITIAL_GREETING_DELAY_MS = 350;
const FIRST_OUTBOUND_AUDIO_MARK = "first_outbound_audio";
const REMOTE_AUDIO_RMS_THRESHOLD = 500;
const HANGUP_DRAIN_GRACE_MS = 200;
const HANGUP_DRAIN_TIMEOUT_MS = 7000;
// A cleared greeting is only worth re-introducing over if the callee both missed
// a real piece of it and never heard enough of the opening to know who is calling.
// Below GREETING_CLIPPED_TAIL_MS the clear only trimmed the tail — whatever the
// greeting said, they heard it. At or past GREETING_IDENTIFIED_MS they stayed with
// it long enough for "this is <name>'s assistant, calling about …" to land, so a
// second introduction reads as a glitch however much came after it.
const GREETING_CLIPPED_TAIL_MS = 400;
const GREETING_IDENTIFIED_MS = 2000;
// A barge-in clears the agent's buffered audio the moment Gemini reports the
// interrupt, but transcription of what the interrupting side actually said can lag
// well behind that: 7.1s and 11.4s in one real call (`call_257cce0c2810.jsonl`).
// Measured against 31 audio_cleared -> next-remote-speech intervals across 21 real
// calls in that same transcripts directory: min 1574ms, p25 2265, median 3968,
// p75 6040, p90 9355, max 32246. Ordinary barge-in transcription lag is already a
// few seconds — the median alone is ~4s — so a low threshold fires on routine
// barge-ins and is useless as an evidence-completeness signal. Set at ~p75 to flag
// the genuinely large gaps (the 7.1s/11.4s class this event exists for) while
// excluding most ordinary ones.
const TRANSCRIPTION_GAP_THRESHOLD_MS = 6000;
// Gemini sends 24kHz mono 16-bit PCM, so two bytes per sample at 24 samples/ms.
const GEMINI_PCM_BYTES_PER_MS = 48;

interface OutboundTurn {
  id: string;
  markName: string;
  audioChunks: number;
  audioBytes: number;
  // When this turn's audio reached Twilio. Gemini generates faster than realtime
  // when healthy, so a turn whose chunks take longer to arrive than the audio takes
  // to play has starved the playback queue, and the callee heard the gaps. Wall
  // clock is the only way to see that — the transcript alone cannot distinguish a
  // stalled generation from a short reply.
  firstAudioAtMs: number | null;
  lastAudioAtMs: number | null;
  maxAudioGapMs: number;
  generated: boolean;
  played: boolean;
  cleared: boolean;
}

/**
 * Batches per-word transcript fragments into turn-level entries.
 * Flushes only when a turn genuinely ends — speaker change, an explicit
 * interrupt, an explicit structured event, or call end — never on a timer.
 * G3 (the voicemail-silence guard) does not depend on this: it reads
 * `lastTranscriptFragmentAt`, stamped on every fragment as it arrives, so a
 * long uninterrupted turn sitting unflushed here can't freeze that clock.
 */
class TranscriptBatcher {
  private session: CallSession;
  private pending: { speaker: "remote" | "local"; textParts: string[]; firstTs: string } | null = null;
  // Set when audio_cleared fires (always the remote side interrupting local audio)
  // and resolved by the next remote speech, however much later that lands — an
  // intervening local turn does not reset it, since the point is whether the
  // callee's own words made it into the transcript, not whether the agent replied
  // in between. See TRANSCRIPTION_GAP_THRESHOLD_MS.
  private pendingInterruptClearedAtMs: number | null = null;

  constructor(session: CallSession) {
    this.session = session;
  }

  append(speaker: "remote" | "local", text: string, ts: string): void {
    // Speaker change — flush previous buffer first
    if (this.pending && this.pending.speaker !== speaker) {
      this.flush("turn_change");
    }

    if (!this.pending) {
      this.pending = { speaker, textParts: [], firstTs: ts };
      if (speaker === "remote" && this.pendingInterruptClearedAtMs !== null) {
        const gapMs = Date.parse(ts) - this.pendingInterruptClearedAtMs;
        this.pendingInterruptClearedAtMs = null;
        if (gapMs > TRANSCRIPTION_GAP_THRESHOLD_MS) {
          appendEvent(this.session, { type: "transcription_gap", speaker, gap_ms: gapMs, ts });
        }
      }
    }

    this.pending.textParts.push(text);
  }

  /** Flush pending buffer before appending a structured event (DTMF, call_ended, etc.). */
  appendDirect(event: TranscriptEvent): void {
    // Always "turn_change": a structured event is itself a turn boundary, even when
    // the caller's own reason is something else (e.g. endTwilioCall's call_ended
    // append flushes the preceding speech turn as turn_change, not call_ended —
    // only cleanup()'s own flush gets that tag).
    this.flush("turn_change");
    appendEvent(this.session, event);
    if (event.type === "audio_cleared") {
      this.pendingInterruptClearedAtMs = Date.parse(event.ts);
    }
  }

  flush(reason: SpeechFlushReason): void {
    if (!this.pending) return;

    const text = this.pending.textParts.join("");
    appendEvent(this.session, {
      type: "speech",
      speaker: this.pending.speaker,
      text,
      ts: this.pending.firstTs,
      flush_reason: reason,
    });
    this.pending = null;
  }

  cleanup(): void {
    this.flush("call_ended");
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
  private usingPreConnectedGemini = false;
  // Between adopting the warm session and draining its greeting buffer, that
  // buffer — not the Twilio socket — is the outbound queue. See handleGeminiAudio.
  private greetingHandoverPending = false;
  private heldGreetingTurnOver = false;
  // The turn the greeting flush created and the moment it was handed to Twilio, so
  // a clear that discards the greeting can be told from one that trims its tail.
  // The turn carries the byte count: on a fast pickup most of the greeting is still
  // generating at flush time and streams into this same turn afterwards.
  private flushedGreetingTurn: OutboundTurn | null = null;
  private greetingFlushedAtMs: number | null = null;
  // Whether the greeting ever finished generating. Only a finished greeting has a
  // tail that a clear can trim; one the callee talked over mid-generation is short
  // because it was cut off, which means the opposite.
  private flushedGreetingComplete = false;
  private greetingDeliveryReported = false;
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
      this.usingPreConnectedGemini = true;
      // A greeting was requested during ringing, so its turn may still be
      // streaming into the session buffer right now. Rebinding makes the live
      // callbacks below hot immediately, which is INITIAL_GREETING_DELAY_MS
      // before the buffer is drained — hold everything until then so the tail of
      // the greeting cannot play ahead of its own opening words.
      this.greetingHandoverPending = Boolean(
        opts.session.preGeneratedGreetingRequestedAt && !opts.session.waitForUserBeforeGreeting,
      );
      this.gemini.rebindCallbacks({
        onAudio: (base64Pcm24k: string) => {
          this.handleGeminiAudio(base64Pcm24k);
        },
        onTranscript: (speaker: "remote" | "local", text: string) => {
          this.handleGeminiTranscript(speaker, text);
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
          this.handleGeminiAudio(base64Pcm24k);
        },
        onTranscript: (speaker: "remote" | "local", text: string) => {
          this.handleGeminiTranscript(speaker, text);
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

  /** Read by `call listen`/`call status`'s `activity.local.speaking` — see callActivity.ts. */
  activeOutboundTurnLastAudioAtMs(): number | null {
    return this.activeOutboundTurn?.lastAudioAtMs ?? null;
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
    // The handover window closes here whichever branch runs below: nothing else
    // drains the buffer, so holding audio past this point would mute the call.
    this.greetingHandoverPending = false;
    // `send_dtmf` swaps the call's TwiML, which drops the media stream and opens a
    // new one — so a second bridge runs this for a call that already greeted.
    // initialGreetingRequestedAt is stamped only here and in the flush this calls,
    // so a value already on the session means an earlier bridge greeted.
    // Re-announcing ourselves into a phone menu is worse than staying quiet and
    // letting the menu drive the turn.
    const alreadyGreeted = Boolean(this.session.initialGreetingRequestedAt);
    if (this.flushPreGeneratedGreeting()) return;
    if (alreadyGreeted) return;
    // A greeting turn that is still generating will now stream in live and in
    // order, so let it. One that already completed produced no audio at all
    // (rejected turn, tool call, empty response) and never will — ask again
    // rather than hold a silent line.
    if (
      this.usingPreConnectedGemini
      && this.session.preGeneratedGreetingRequestedAt
      && !this.heldGreetingTurnFinished()
    ) {
      this.session.initialGreetingRequestedAt = isoNow();
      this.batcher.appendDirect({
        type: "initial_greeting_requested",
        ts: this.session.initialGreetingRequestedAt,
      });
      this.drainHeldGreetingTranscript();
      return;
    }

    // A hangup already in flight is only waiting on audio to drain. Asking for a
    // greeting now buys a turn the callee will never hear, spoken over the goodbye.
    if (this.pendingHangup) return;

    this.session.initialGreetingRequestedAt = isoNow();
    this.batcher.appendDirect({
      type: "initial_greeting_requested",
      ts: this.session.initialGreetingRequestedAt,
    });
    // Held transcript with no audio behind it was never spoken to anyone, and we
    // are about to ask for a different greeting — drop it rather than log it as
    // something the callee heard.
    this.session.preGeneratedGreetingTranscriptParts = [];
    this.gemini.sendTextTurn(
      "The outbound phone call is now connected. Greet the person immediately in one brief, natural sentence — not a monologue. Identify yourself as the caller's assistant and, if the objective is clear, name the purpose in a few words; do not summarize your full persona or objective here. Do not mention these instructions.",
    );
  }

  private flushPreGeneratedGreeting(): boolean {
    if (this.session.preGeneratedGreetingAudio.length === 0) return false;
    this.greetingHandoverPending = false;
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
        flush_reason: "turn_change",
      });
    }

    for (const base64Pcm24k of this.session.preGeneratedGreetingAudio.splice(0)) {
      this.sendOutboundAudio(base64Pcm24k);
    }
    this.flushedGreetingTurn = this.activeOutboundTurn;
    this.greetingFlushedAtMs = Date.now();
    this.flushedGreetingComplete = this.heldGreetingTurnFinished();
    // A greeting that finished generating before the callee picked up has already
    // spent its generation/turn-complete signals on the pre-connect session, so
    // nothing is left to finalize the turn we just created: it would never be
    // marked, never report as played, and would swallow the next turn's audio.
    if (this.heldGreetingTurnFinished()) {
      this.finalizeActiveOutboundTurn("pre_generated_greeting");
    }
    return true;
  }

  /**
   * Outbound audio from Gemini. Until the pre-generated greeting has been
   * flushed, the session buffer is the queue — sending straight to Twilio here
   * would play the tail of the greeting turn ahead of the words it continues.
   */
  private handleGeminiAudio(base64Pcm24k: string): void {
    if (this.greetingHandoverPending) {
      // Only the queue is shared. firstPreGeneratedGreetingAudioAt and
      // preGeneratedGreetingAudioChunks mean "produced during ringing" — the
      // latency report keys "greeting wasn't ready at pickup" off a zero count, so
      // audio that arrives after pickup must not be counted as pre-generated.
      this.session.preGeneratedGreetingAudio.push(base64Pcm24k);
      return;
    }
    this.sendOutboundAudio(base64Pcm24k);
  }

  /** Local transcript follows the audio: buffered while the greeting is held. */
  private handleGeminiTranscript(speaker: "remote" | "local", text: string): void {
    if (this.cleaned) return;
    // Stamped on arrival, ahead of the batcher, so G3 sees this fragment even if it
    // sits in TranscriptBatcher's pending buffer for the rest of a long turn.
    this.session.lastTranscriptFragmentAt = Date.now();
    if (speaker === "local" && this.greetingHandoverPending) {
      this.session.preGeneratedGreetingTranscriptParts.push(text);
      return;
    }
    this.batcher.append(speaker, text, isoNow());
  }

  /**
   * Hand held transcript back to the batcher when the flush had no audio to play.
   * Transcription can lead the first audio chunk across the handover boundary, and
   * the flush is the buffer's only drain — left there, words the callee is about to
   * hear are wiped by finalizeCall and the saved transcript no longer matches the
   * call. Merging into the batcher instead keeps them in one turn with the rest.
   */
  private drainHeldGreetingTranscript(): void {
    for (const text of this.session.preGeneratedGreetingTranscriptParts.splice(0)) {
      this.batcher.append("local", text, isoNow());
    }
  }

  private sendOutboundAudio(base64Pcm24k: string): void {
    if (this.cleaned || !this.session.streamSid) return;
    const isFirstOutboundAudio = this.noteFirstOutboundAudio();
    const turn = this.ensureOutboundTurn();
    turn.audioChunks += 1;
    turn.audioBytes += Buffer.byteLength(base64Pcm24k, "base64");
    this.noteOutboundAudioArrival(turn);
    const mulawPayload = geminiToTwilio(base64Pcm24k);
    try {
      this.session.localAudioChunks.push(Buffer.from(mulawPayload, "base64"));
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

  /**
   * Measured here rather than in handleGeminiAudio: only audio that actually goes
   * out can starve playback. Greeting audio buffered during ringing arrives while
   * nothing is playing, and it is flushed in one burst, so its gaps mean nothing.
   */
  private noteOutboundAudioArrival(turn: OutboundTurn): void {
    const nowMs = Date.now();
    if (turn.lastAudioAtMs !== null) {
      turn.maxAudioGapMs = Math.max(turn.maxAudioGapMs, nowMs - turn.lastAudioAtMs);
    }
    turn.firstAudioAtMs ??= nowMs;
    turn.lastAudioAtMs = nowMs;
  }

  /**
   * Playable duration versus the wall clock it took to arrive. Starvation is the
   * excess: the callee spent that long listening to silence inside one turn.
   */
  private outboundTurnDelivery(turn: OutboundTurn): {
    audio_ms: number;
    stream_span_ms: number;
    max_audio_gap_ms: number;
  } | undefined {
    if (turn.firstAudioAtMs === null || turn.lastAudioAtMs === null) return undefined;
    return {
      audio_ms: Math.round(turn.audioBytes / GEMINI_PCM_BYTES_PER_MS),
      stream_span_ms: turn.lastAudioAtMs - turn.firstAudioAtMs,
      max_audio_gap_ms: Math.round(turn.maxAudioGapMs),
    };
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
      audioBytes: 0,
      firstAudioAtMs: null,
      lastAudioAtMs: null,
      maxAudioGapMs: 0,
      generated: false,
      played: false,
      cleared: false,
    };
    this.activeOutboundTurn = turn;
    this.outboundTurnsByMark.set(turn.markName, turn);
    return turn;
  }

  private handleGenerationComplete(): void {
    this.noteHeldGreetingTurnOver("completed");
    this.noteFlushedGreetingComplete();
    this.finalizeActiveOutboundTurn("generation_complete");
  }

  private handleTurnComplete(): void {
    this.noteHeldGreetingTurnOver("completed");
    this.noteFlushedGreetingComplete();
    this.finalizeActiveOutboundTurn("turn_complete");
  }

  /**
   * A greeting still generating at pickup keeps streaming into its flushed turn, so
   * its completion arrives after the handover window has closed and
   * noteHeldGreetingTurnOver no longer records anything. Catch it here, because
   * whether the greeting ever finished is what tells a trimmed tail from a
   * truncation. Interrupts deliberately do not come through here.
   */
  private noteFlushedGreetingComplete(): void {
    if (this.flushedGreetingTurn && this.activeOutboundTurn === this.flushedGreetingTurn) {
      this.flushedGreetingComplete = true;
    }
  }

  /**
   * A signal that the held greeting turn is over, arriving inside the handover
   * window: there is no outbound turn yet for it to finalize and none will exist
   * until the flush, so record it or the flushed turn is never finalized, never
   * marked, and swallows the next turn's audio.
   *
   * Only a real completion stamps the session, because that timestamp is the call
   * summary's greeting-generation timing — an interrupted turn stopped early and
   * would report an abandonment as a generation duration.
   */
  private noteHeldGreetingTurnOver(outcome: "completed" | "interrupted"): void {
    if (!this.greetingHandoverPending) return;
    this.heldGreetingTurnOver = true;
    if (outcome !== "completed" || this.session.preGeneratedGreetingTurnComplete) return;
    this.session.preGeneratedGreetingTurnComplete = true;
    this.session.preGeneratedGreetingTurnCompleteAt = isoNow();
  }

  /** Nothing more is coming for the greeting the flush is about to hand to Twilio. */
  private heldGreetingTurnFinished(): boolean {
    return this.heldGreetingTurnOver || this.session.preGeneratedGreetingTurnComplete;
  }

  private handleInterrupted(): void {
    // Deliberately not touching a greeting still held in the buffer. Nothing has
    // played yet inside the handover window, so an interrupt there is the callee
    // saying "hello?" into a silent line, not a barge-in over us — they still need
    // to hear who is calling, and the flush is what gets them that. The turn is
    // over though, and an interrupted turn gets no generation/turn-complete
    // signal, so record it or the flush leaves its turn unfinalized forever.
    this.noteHeldGreetingTurnOver("interrupted");
    // Explicit and unconditional: clearBufferedOutboundAudio and
    // finalizeActiveOutboundTurn below both early-return when there is no
    // outbound audio in flight (outboundTurnsByMark.size === 0, or
    // turn.audioChunks === 0), so a pending remote turn interrupted mid-sentence
    // with nothing of ours queued would otherwise never get flushed at all —
    // there is no idle timer left to catch it.
    this.batcher.flush("interrupted");
    this.clearBufferedOutboundAudio("gemini_interrupted");
    this.finalizeActiveOutboundTurn("interrupted");
    this.notifyIfGreetingWentUnheard();
  }

  /**
   * A pre-generated greeting is the one turn where Gemini's context and the
   * callee's ears can disagree. The turn completed on the model's side during
   * ringing, so an interruption that clears it out of Twilio's queue leaves the
   * model believing it introduced itself to someone who heard a fraction of a
   * second of it — and the pre-connect prompt tells it not to repeat the greeting,
   * so nothing re-identifies. Tell it what actually reached the line.
   *
   * Sent on the realtime channel: the callee is mid-sentence, and a turn barrier
   * here would talk over them. The model folds this into its next reply.
   */
  private notifyIfGreetingWentUnheard(): void {
    const greeting = this.flushedGreetingTurn;
    const startedAtMs = this.greetingFlushedAtMs;
    if (!greeting || startedAtMs === null || this.greetingDeliveryReported || this.cleaned) return;
    // Nothing was discarded, so nothing was missed: an interrupt after the turn has
    // drained finds an empty queue and clearBufferedOutboundAudio no-ops. Note that
    // a turn's mark still comes back after a clear, so `played` says the queue
    // emptied, not that the callee heard it — only `cleared` is load-bearing here.
    if (!greeting.cleared) return;

    // Elapsed since the flush, not since Twilio's first_outbound_audio mark: a
    // `clear` releases every mark Twilio still had queued, so that mark can land
    // *after* the greeting was discarded. Re-reading it per interrupt would move the
    // start of playback forward mid-call and make a greeting the callee sat through
    // look like one they never heard.
    const playedMs = Date.now() - startedAtMs;
    // The whole turn, not just what was buffered at pickup: on a fast answer most of
    // the greeting is still generating and streams into this same turn afterwards, so
    // the buffered slice alone understates it — the case this check exists for.
    const greetingMs = greeting.audioBytes / GEMINI_PCM_BYTES_PER_MS;
    const unheardMs = greetingMs - playedMs;
    // The tail-trim guard only means anything for a greeting that finished. A callee
    // fast enough to talk over the opening syllable kills generation too, leaving a
    // greeting that is *entirely* opening syllable: barely anything discarded, and
    // barely anything heard. Judged as a trimmed tail, that reads as delivered.
    if (this.flushedGreetingComplete && unheardMs <= GREETING_CLIPPED_TAIL_MS) return;

    const outcome = playedMs >= GREETING_IDENTIFIED_MS
      ? "identified"
      // A recording is not owed an introduction, and on a machine pickup a cleared
      // greeting is the normal case rather than a barge-in: the outgoing message
      // starts talking the moment the line opens.
      : this.answeredByMachine()
        ? "machine"
        // A hangup already in flight is only waiting on audio to drain. Asking the
        // model to re-identify now buys a turn spoken over the goodbye, and that
        // pending turn holds the hangup open for the whole drain timeout. Same
        // reasoning as sendInitialGreetingNow, which refuses to greet here.
        : this.pendingHangup
          ? "hangup_draining"
          : "re_identify_requested";

    // Recorded whichever way it went: the daemon's stdout is not visible to whoever
    // placed the call, and these are the numbers that say whether the thresholds are
    // right. 'call listen' can then show why a call did or did not re-introduce.
    this.greetingDeliveryReported = true;
    this.batcher.appendDirect({
      type: "greeting_delivery",
      ts: isoNow(),
      outcome,
      heard_ms: Math.max(0, Math.round(Math.min(playedMs, greetingMs))),
      greeting_ms: Math.round(greetingMs),
      ...(this.session.answeredBy ? { answered_by: this.session.answeredBy } : {}),
    });
    if (outcome !== "re_identify_requested") return;

    console.log(
      `[media-bridge] Greeting for call ${this.callId} cleared after ~${Math.max(0, Math.round(playedMs))}ms `
      + `of ~${Math.round(greetingMs)}ms — telling the model it was not heard`,
    );
    const note = "System note: the other party started speaking before they could hear your greeting, "
      + "so they do not know who is calling or why. Identify yourself briefly in your next reply, then continue.";
    this.batcher.appendDirect({ type: "call_steered", ts: isoNow(), mode: "nudge", text: note });
    this.gemini.steer(note);
  }

  /**
   * Twilio AMD verdicts are human, fax, unknown, machine_start and
   * machine_end_beep/_silence/_other. Anything it could not classify counts as a
   * person, since a missed re-identification costs more than a wasted one.
   *
   * Async AMD runs `DetectMessageEnd`, so this verdict lands when the outgoing
   * message finishes — usually after the first barge-in, and this only suppresses
   * interrupts that arrive once it is known (the beep, or the callee's own machine
   * talking on).
   */
  private answeredByMachine(): boolean {
    const answeredBy = this.session.answeredBy;
    return Boolean(answeredBy && (answeredBy.startsWith("machine") || answeredBy === "fax"));
  }

  private handleGeminiEnd(): void {
    console.log(`[media-bridge] Gemini session ended for call ${this.callId}`);
    if (this.pendingHangup || this.pendingOutboundTurn()) {
      this.tryDrainPendingHangup();
      return;
    }
    // An invalid API key, a rejected model/voice and an exhausted quota all
    // survive connect() and arrive as a close moments later, so a Gemini setup
    // failure looks like a session that ended before the callee heard anything.
    // Plain cleanup() would write a transcript with no error marker at all, and
    // the silent failed call would read as "the callee said nothing".
    if (!this.session.firstOutboundAudioAt) {
      const detail = this.gemini.closeReason ?? "the Live session closed before producing any audio";
      this.batcher.appendDirect({ type: "preconnect_failed", ts: isoNow(), message: detail });
      this.endTwilioCall(`Call ${this.callId} — Gemini unavailable: ${detail}`);
      return;
    }
    this.cleanup();
  }

  private finalizeActiveOutboundTurn(reason: string): void {
    const turn = this.activeOutboundTurn;
    if (!turn || turn.generated || turn.audioChunks === 0) return;

    turn.generated = true;
    const delivery = this.outboundTurnDelivery(turn);
    if (delivery) {
      const starvationMs = Math.max(0, delivery.stream_span_ms - delivery.audio_ms);
      this.session.maxOutboundAudioGapMs = Math.max(
        this.session.maxOutboundAudioGapMs ?? 0,
        delivery.max_audio_gap_ms,
      );
      this.session.maxOutboundAudioStarvationMs = Math.max(
        this.session.maxOutboundAudioStarvationMs ?? 0,
        starvationMs,
      );
    }
    this.batcher.appendDirect({
      type: "outbound_turn_generated",
      ts: isoNow(),
      turn_id: turn.id,
      reason,
      ...(delivery ?? {}),
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
          this.session.remoteAudioChunks.push(Buffer.from(msg.media.payload, "base64"));
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
    // Set before the update, not in its callback: Twilio tears the stream down as
    // soon as it applies this TwiML, and that `stop` does not have to wait for our
    // HTTP response. Cleared again if the request fails, so a DTMF that never
    // happened cannot leave the session waiting for a stream that is not coming.
    this.session.expectingStreamReconnect = true;
    client.calls(callSid).update({ twiml })
      .then(() => {
        console.log(`[media-bridge] Sent DTMF: ${digits}`);
        this.batcher.appendDirect({ type: "dtmf", ts: isoNow(), digits });
        this.gemini.sendToolResponse(id, "send_dtmf", { success: true, digits });
      })
      .catch((err: Error) => {
        this.session.expectingStreamReconnect = false;
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
      // Audio can still be owed here: an open handover window means the greeting is
      // either buffered or still generating, and neither has a turn for
      // pendingOutboundTurn() to find, so an end_call at pickup would otherwise
      // hang up on a silent line. Anything queued during the grace window is
      // likewise not something to clip. The window closes on its own timer and
      // HANGUP_DRAIN_TIMEOUT_MS bounds the whole wait, so this cannot stall.
      if (this.greetingHandoverPending || this.pendingOutboundTurn()) {
        this.tryDrainPendingHangup();
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingHangup = null;
      this.endTwilioCall(pending.reason);
    }, HANGUP_DRAIN_GRACE_MS);
  }

  // Shared by every call-ending path (endTwilioCall, cleanup()) so a path that
  // already appended one before another runs does not get a second.
  private appendCallEndedIfMissing(reason: string): void {
    if (this.session.fullTranscript.some((event) => event.type === "call_ended")) {
      return;
    }
    this.batcher.appendDirect({
      type: "call_ended",
      ts: isoNow(),
      reason,
      duration_ms: Date.now() - this.session.startTime,
    });
  }

  private endTwilioCall(reason: string): void {
    // Ending the call outranks a DTMF reconnect: no further stream is coming, and
    // the transcript has to be finalized by the cleanup this schedules.
    this.session.expectingStreamReconnect = false;
    if (this.pendingHangup) {
      clearTimeout(this.pendingHangup.timeout);
      this.pendingHangup = null;
    }
    if (this.hangupGraceTimer) {
      clearTimeout(this.hangupGraceTimer);
      this.hangupGraceTimer = null;
    }

    this.appendCallEndedIfMissing(reason);

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
    // Nothing will drain the buffer now; leaving the flag set would only keep
    // late Gemini audio accumulating in a session that is finished with it.
    this.greetingHandoverPending = false;
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

    // A newer bridge already owns this call — the reconnect's stream landed before
    // this teardown ran — so none of the session state below is ours to touch.
    if (this.session.bridge && this.session.bridge !== this) {
      console.log(`[media-bridge] Call ${this.callId} handed to a newer stream — leaving it live`);
      return;
    }

    this.session.ws = undefined;
    this.session.bridge = undefined;

    // `send_dtmf` swaps the call's TwiML, which drops this stream and immediately
    // opens another one for the same call. Ending the session here would write the
    // transcript at the DTMF and set finalizeCall's idempotency guard, so the whole
    // rest of the conversation would stay in memory and never reach disk. Leave the
    // call live for the next bridge; if the stream never comes back, the inactivity
    // sweep ends and finalizes it.
    if (this.session.expectingStreamReconnect) {
      console.log(`[media-bridge] Call ${this.callId} awaiting stream reconnect — not finalizing`);
      return;
    }

    // Mark session ended
    this.session.status = "ended";

    // Twilio-initiated teardowns (WS close, Twilio `stop`, Gemini ending the
    // session) reach here without ever calling endTwilioCall/forceHangup/
    // handleCallHangup, so without this the transcript can end with no call_ended
    // event at all.
    this.appendCallEndedIfMissing("media stream closed");

    // Notify server to finalize the transcript.
    if (this.onCleanup) {
      this.onCleanup();
    }
  }
}
