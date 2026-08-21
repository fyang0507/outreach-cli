// Shared fakes for driving MediaStreamsBridge without Twilio or Gemini.
// The bridge only ever calls the methods below on either side, so duck types are
// enough — and keeping one copy means a new bridge dependency is added once.
import { MediaStreamsBridge } from "../../../dist/daemon/mediaStreamsBridge.js";
import { createSession } from "../../../dist/daemon/sessions.js";

export const STREAM_SID = "MZtest";
/** 24kHz mono 16-bit PCM: 48 bytes per ms, so 24000 samples = 1000ms. */
const ONE_SECOND_SAMPLES = 24000;

export function pcmSeconds(seconds) {
  const pcm = new Int16Array(ONE_SECOND_SAMPLES * seconds).fill(1000);
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

export function fakeTwilioWs() {
  const handlers = {};
  const sent = [];
  return {
    sent,
    on(event, cb) { handlers[event] = cb; },
    sendTwilioEvent(msg) { handlers.message?.(JSON.stringify(msg)); },
    /** Fires a raw WS event (e.g. "error", "close") the bridge registered via on(). */
    emit(event, payload) { handlers[event]?.(payload); },
    send(raw) { sent.push(JSON.parse(raw)); },
    close() {},
    cleared() { return sent.filter((m) => m.event === "clear").length; },
    mediaChunks() { return sent.filter((m) => m.event === "media").length; },
  };
}

export function fakeGemini() {
  return {
    callbacks: null,
    steerNotes: [],
    textTurns: [],
    toolResponses: [],
    isClosed: false,
    closeReason: undefined,
    rebindCallbacks(cbs) { this.callbacks = cbs; },
    sendAudio() {},
    sendTextTurn(text) { this.textTurns.push(text); },
    steer(note) { this.steerNotes.push(note); },
    sendToolResponse(id, name, payload) { this.toolResponses.push({ id, name, payload }); },
    close() { this.isClosed = true; },
  };
}

/** A call that has been answered, with no pre-generated greeting in play. */
export function answeredSession() {
  const session = createSession({ from: "+15550000000", to: "+15551111111" });
  session.mediaStreamStartedAt = new Date().toISOString();
  session.streamSid = STREAM_SID;
  session.status = "in_progress";
  return session;
}

export function startBridge(session, gemini, twilioWs) {
  const bridge = new MediaStreamsBridge({
    twilioWs,
    callId: session.id,
    session,
    apiKey: "test-key",
    geminiConfig: {},
    systemInstruction: "test",
    preConnectedGemini: gemini,
  });
  session.bridge = bridge;
  return bridge;
}

export function turnEvents(session) {
  return session.fullTranscript.filter((e) => e.type === "outbound_turn_generated");
}
