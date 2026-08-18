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

function deliveryEvents(session) {
  return session.fullTranscript.filter((e) => e.type === "greeting_delivery");
}

// Date is mocked alongside setTimeout throughout: how much of the greeting the
// callee heard is measured off the wall clock, so a test that only controls timers
// measures every greeting as heard for 0ms and cannot express the cases below.
// call_4b5b876320cc: the greeting was cleared 263ms into a ~5s greeting, and the
// model — whose turn had completed during ringing — never re-identified.
test("a greeting cleared moments after it starts tells the model it was not heard", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
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
  // The measurement behind that decision, so the thresholds can be judged from
  // 'call listen' rather than from the daemon's stdout.
  assert.deepEqual(deliveryEvents(session).map((e) => [e.outcome, e.heard_ms, e.greeting_ms]), [
    ["re_identify_requested", 0, 5000],
  ]);

  // Only once, however many interrupts follow.
  gemini.callbacks.onInterrupted();
  assert.equal(gemini.steerNotes.length, 1);

  bridge.cleanup();
  deleteSession(session.id);
});

test("a barge-in over the tail of a greeting they heard does not re-introduce", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(1); // 1000ms of speech
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  twilioWs.sendTwilioEvent({ event: "mark", streamSid: STREAM_SID, mark: { name: "first_outbound_audio" } });
  // They sat through all but the last 100ms of it before speaking.
  t.mock.timers.tick(900);
  gemini.callbacks.onInterrupted();

  // The clear only trimmed the tail: the callee got the identification, so a second
  // one would read as a glitch — and there is nothing worth recording either.
  assert.deepEqual(gemini.steerNotes, []);
  assert.deepEqual(steerEvents(session), []);
  assert.deepEqual(deliveryEvents(session), []);

  bridge.cleanup();
  deleteSession(session.id);
});

// A long greeting is the case a remainder-only threshold gets backwards: 4s of it
// was discarded, but the callee had already heard who was calling.
test("a barge-in after the identification landed does not re-introduce", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(7);
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  t.mock.timers.tick(3000);
  gemini.callbacks.onInterrupted();

  assert.equal(twilioWs.cleared(), 1, "the rest of the greeting is still dropped");
  assert.deepEqual(gemini.steerNotes, [], "3s in, they know who is calling");
  assert.deepEqual(steerEvents(session), []);
  // 4s of greeting was discarded, so the call is still worth explaining.
  assert.deepEqual(deliveryEvents(session).map((e) => [e.outcome, e.heard_ms, e.greeting_ms]), [
    ["identified", 3000, 7000],
  ]);

  bridge.cleanup();
  deleteSession(session.id);
});

// call_cf7deb620076: the callee answered and spoke over the first syllable, which
// cut generation off at 261ms. Only 37ms was discarded, so a tail-trim guard reads it
// as delivered — but they heard "Hello, I'm" and the agent never said who it was.
test("a barge-in that truncates the greeting mid-generation still re-identifies", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(0.25);
  session.preGeneratedGreetingTurnComplete = false;
  session.preGeneratedGreetingTurnCompleteAt = undefined;
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  t.mock.timers.tick(200);
  // No generation_complete ever arrives: the interrupt is what ended this turn.
  gemini.callbacks.onInterrupted();

  assert.equal(gemini.steerNotes.length, 1, "50ms unheard, but only 200ms was ever heard");
  assert.deepEqual(deliveryEvents(session).map((e) => [e.outcome, e.heard_ms, e.greeting_ms]), [
    ["re_identify_requested", 200, 250],
  ]);

  bridge.cleanup();
  deleteSession(session.id);
});

// The same small remainder means the opposite once the greeting finished generating.
test("a completed greeting missing only its tail still stays quiet", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(0.25);
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  t.mock.timers.tick(200);
  gemini.callbacks.onInterrupted();

  assert.deepEqual(gemini.steerNotes, [], "a 250ms greeting that finished is a greeting they heard");
  assert.deepEqual(deliveryEvents(session), []);

  bridge.cleanup();
  deleteSession(session.id);
});

// The greeting was still generating at pickup, so most of it reaches Twilio after
// the flush — as part of the same turn. Counting only the buffered slice makes a
// call that lost ~4.6s of greeting look like it lost 400ms.
test("a greeting still generating at pickup counts the audio that arrives after the flush", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(0.8);
  session.preGeneratedGreetingTurnComplete = false;
  session.preGeneratedGreetingTurnCompleteAt = undefined;
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  // The remaining 4.2s of the same greeting turn streams in live, in order.
  gemini.callbacks.onAudio(pcmSeconds(4.2));
  t.mock.timers.tick(400);
  gemini.callbacks.onInterrupted();

  assert.equal(twilioWs.cleared(), 1);
  assert.equal(gemini.steerNotes.length, 1, "~4.6s of the greeting was discarded unheard");
  assert.match(gemini.steerNotes[0], /do not know who is calling/);
  assert.equal(steerEvents(session).length, 1);

  bridge.cleanup();
  deleteSession(session.id);
});

// Twilio releases the marks it still had queued when a `clear` lands, so
// first_outbound_audio can arrive after the greeting was discarded. Treating it as
// the start of playback would restart the clock on a greeting already heard.
test("a first-audio mark released by the clear does not restart the playback clock", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(5);
  // Ten chunks, so Twilio can return the first_outbound_audio mark once the opening
  // 500ms has played rather than only after the whole greeting drains.
  session.preGeneratedGreetingAudio = Array.from({ length: 10 }, () => pcmSeconds(0.5));
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  t.mock.timers.tick(500);
  twilioWs.sendTwilioEvent({ event: "mark", streamSid: STREAM_SID, mark: { name: "first_outbound_audio" } });
  // The callee stays with it well past the identification, then speaks: 2200ms after
  // the flush, but only 1700ms after the mark came back. Anchoring on the mark would
  // re-introduce the agent to someone who sat through more than two seconds of it.
  t.mock.timers.tick(1700);
  gemini.callbacks.onInterrupted();

  assert.deepEqual(gemini.steerNotes, [], "2.2s of greeting carried the identification");
  assert.deepEqual(steerEvents(session), []);
  assert.deepEqual(deliveryEvents(session).map((e) => [e.outcome, e.heard_ms, e.greeting_ms]), [
    ["identified", 2200, 5000],
  ]);

  bridge.cleanup();
  deleteSession(session.id);
});

// A tail trim reports nothing, so nothing is latched — which leaves the next
// interrupt free to measure again, and Twilio releases the queued mark in between.
test("a late mark after a tail trim does not turn a heard greeting into an unheard one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(5);
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  t.mock.timers.tick(4800);
  gemini.callbacks.onInterrupted();
  assert.deepEqual(deliveryEvents(session), [], "200ms of tail is not worth reporting");

  twilioWs.sendTwilioEvent({ event: "mark", streamSid: STREAM_SID, mark: { name: "first_outbound_audio" } });
  t.mock.timers.tick(100);
  gemini.callbacks.onInterrupted();

  assert.deepEqual(gemini.steerNotes, [], "the callee heard 4.9s of it");
  assert.deepEqual(deliveryEvents(session), []);

  bridge.cleanup();
  deleteSession(session.id);
});

// The model asked to hang up, and the callee/machine then talked over the greeting.
// A re-introduction here is spoken over the goodbye, and its turn holds the pending
// hangup open for the full drain timeout.
test("a greeting cleared while a hangup drains does not buy a re-introduction", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(5);
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  gemini.callbacks.onToolCall("end_call", { reason: "reached voicemail" }, "tool-1");
  gemini.callbacks.onInterrupted();

  assert.equal(twilioWs.cleared(), 1);
  assert.deepEqual(gemini.steerNotes, [], "the goodbye is already in flight");
  assert.deepEqual(steerEvents(session), []);
  assert.deepEqual(deliveryEvents(session).map((e) => e.outcome), ["hangup_draining"]);

  bridge.cleanup();
  deleteSession(session.id);
});

// On a machine pickup the outgoing message starts talking the moment the line opens,
// so a cleared greeting plus a Gemini interrupt is the normal case rather than a
// barge-in — and a recording is not owed an introduction.
test("a machine pickup is not asked to be re-introduced to", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(5);
  session.answeredBy = "machine_end_beep";
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  gemini.callbacks.onInterrupted();

  assert.equal(twilioWs.cleared(), 1);
  assert.deepEqual(gemini.steerNotes, []);
  assert.deepEqual(steerEvents(session), []);
  assert.deepEqual(deliveryEvents(session).map((e) => [e.outcome, e.answered_by]), [
    ["machine", "machine_end_beep"],
  ]);

  bridge.cleanup();
  deleteSession(session.id);
});

// AMD reports human on a person who answered and immediately said "hello?" — and
// "unknown" is deliberately treated the same way, since a missed re-identification
// costs more than a wasted one.
test("an unclassified pickup still gets the re-identification", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = sessionWithGreeting(5);
  session.answeredBy = "unknown";
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  gemini.callbacks.onInterrupted();

  assert.equal(gemini.steerNotes.length, 1);
  assert.deepEqual(deliveryEvents(session).map((e) => e.outcome), ["re_identify_requested"]);

  bridge.cleanup();
  deleteSession(session.id);
});

test("a greeting Twilio confirmed as played is never treated as unheard", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
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
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
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
