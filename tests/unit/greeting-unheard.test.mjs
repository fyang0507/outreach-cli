import assert from "node:assert/strict";
import test from "node:test";

import { MediaStreamsBridge } from "../../dist/daemon/mediaStreamsBridge.js";
import { createSession, deleteSession } from "../../dist/daemon/sessions.js";

const PAST_GREETING_DELAY_MS = 400;
const STREAM_SID = "MZtest";
// 24kHz mono 16-bit PCM: 48 bytes per ms. 24000 samples = 48000 bytes = 1000ms.
const ONE_SECOND_SAMPLES = 24000;

delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

function pcmSeconds(seconds) {
  const pcm = new Int16Array(ONE_SECOND_SAMPLES * seconds).fill(1000);
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

function fakeTwilioWs() {
  const handlers = {};
  const sent = [];
  return {
    sent,
    on(event, cb) {
      handlers[event] = cb;
    },
    sendTwilioEvent(msg) {
      handlers.message?.(JSON.stringify(msg));
    },
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close() {},
    cleared() {
      return sent.filter((m) => m.event === "clear").length;
    },
  };
}

function fakeGemini() {
  return {
    callbacks: null,
    steerNotes: [],
    textTurns: [],
    isClosed: false,
    closeReason: undefined,
    rebindCallbacks(cbs) {
      this.callbacks = cbs;
    },
    sendAudio() {},
    sendTextTurn(text) {
      this.textTurns.push(text);
    },
    steer(note) {
      this.steerNotes.push(note);
    },
    sendToolResponse() {},
    close() {
      this.isClosed = true;
    },
  };
}

/** Pickup with a greeting of `seconds` already generated and buffered. */
function sessionWithGreeting(seconds) {
  const session = createSession({ from: "+15550000000", to: "+15551111111" });
  session.preGeneratedGreetingRequestedAt = new Date().toISOString();
  session.mediaStreamStartedAt = new Date().toISOString();
  session.streamSid = STREAM_SID;
  session.status = "in_progress";
  session.preGeneratedGreetingAudio = [pcmSeconds(seconds)];
  session.preGeneratedGreetingAudioChunks = 1;
  session.preGeneratedGreetingTranscriptParts = ["Hello, this is Fred's assistant, calling about the weather."];
  session.preGeneratedGreetingTurnComplete = true;
  session.preGeneratedGreetingTurnCompleteAt = new Date().toISOString();
  return session;
}

function startBridge(session, gemini, twilioWs) {
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

function steerEvents(session) {
  return session.fullTranscript.filter((e) => e.type === "call_steered");
}

// call_4b5b876320cc: the greeting was cleared 263ms into a ~5s greeting, and the
// model — whose turn had completed during ringing — never re-identified.
test("a greeting cleared moments after it starts tells the model it was not heard", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = sessionWithGreeting(5);
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  // Twilio confirms the first chunk landed, then the callee talks over it.
  twilioWs.sendTwilioEvent({ event: "mark", streamSid: STREAM_SID, mark: { name: "first_outbound_audio" } });
  gemini.callbacks.onInterrupted();

  assert.equal(twilioWs.cleared(), 1, "queued audio is still dropped — that part is correct");
  assert.equal(gemini.steerNotes.length, 1, "the model must learn its greeting never landed");
  assert.match(gemini.steerNotes[0], /do not know who is calling/);
  assert.equal(steerEvents(session).length, 1, "and the transcript must show why it re-introduced itself");
  assert.deepEqual(gemini.textTurns, [], "no forced turn over a talking callee");

  // Only once, however many interrupts follow.
  gemini.callbacks.onInterrupted();
  assert.equal(gemini.steerNotes.length, 1);

  bridge.cleanup();
  deleteSession(session.id);
});

test("a barge-in over the tail of a greeting they heard does not re-introduce", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = sessionWithGreeting(1); // 1000ms of speech
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  twilioWs.sendTwilioEvent({ event: "mark", streamSid: STREAM_SID, mark: { name: "first_outbound_audio" } });
  gemini.callbacks.onInterrupted();

  // 1000ms of audio leaves at most 1000ms unheard, under the threshold: the callee
  // got the identification, so a second one would read as a glitch.
  assert.deepEqual(gemini.steerNotes, []);
  assert.deepEqual(steerEvents(session), []);

  bridge.cleanup();
  deleteSession(session.id);
});

test("a greeting Twilio confirmed as played is never treated as unheard", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = sessionWithGreeting(5);
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);

  const [turn] = session.fullTranscript.filter((e) => e.type === "outbound_turn_generated");
  twilioWs.sendTwilioEvent({ event: "mark", streamSid: STREAM_SID, mark: { name: `${turn.turn_id}_played` } });
  gemini.callbacks.onInterrupted();

  assert.deepEqual(gemini.steerNotes, [], "the whole greeting drained before the interrupt");

  bridge.cleanup();
  deleteSession(session.id);
});

test("an interrupt with no greeting turn at all stays silent", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = sessionWithGreeting(5);
  session.preGeneratedGreetingAudio = [];
  session.preGeneratedGreetingAudioChunks = 0;
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  gemini.callbacks.onInterrupted();

  assert.deepEqual(gemini.steerNotes, [], "nothing was flushed, so nothing was lost");

  bridge.cleanup();
  deleteSession(session.id);
});
