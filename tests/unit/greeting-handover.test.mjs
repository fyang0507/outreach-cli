import assert from "node:assert/strict";
import test from "node:test";

import { MediaStreamsBridge } from "../../dist/daemon/mediaStreamsBridge.js";
import { createSession, deleteSession } from "../../dist/daemon/sessions.js";
import { geminiToTwilio } from "../../dist/audio/transcode.js";

// Past INITIAL_GREETING_DELAY_MS (350ms) and HANGUP_DRAIN_GRACE_MS (200ms). Timers
// are mocked per test, so these are ticks, not waits.
const PAST_GREETING_DELAY_MS = 400;
const PAST_HANGUP_GRACE_MS = 300;
const STREAM_SID = "MZtest";

// endTwilioCall reaches for the Twilio REST client when these are set; the
// transcript assertions below don't need it and a real client would outlive the test.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

/** Distinct 24kHz PCM chunk so transcoded payloads can be compared by identity. */
function pcmChunk(value, samples = 240) {
  const pcm = new Int16Array(samples).fill(value);
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
    emit(event, payload) {
      handlers[event]?.(payload);
    },
    sendTwilioEvent(msg) {
      handlers.message?.(JSON.stringify(msg));
    },
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close() {},
    mediaPayloads() {
      return sent.filter((m) => m.event === "media").map((m) => m.media.payload);
    },
    markNames() {
      return sent.filter((m) => m.event === "mark").map((m) => m.mark.name);
    },
  };
}

/** Duck-typed GeminiLiveSession: the bridge only ever calls these. */
function fakeGemini() {
  return {
    callbacks: null,
    textTurns: [],
    toolResponses: [],
    isClosed: false,
    closeReason: undefined,
    rebindCallbacks(cbs) {
      this.callbacks = cbs;
    },
    sendAudio() {},
    sendTextTurn(text) {
      this.textTurns.push(text);
    },
    steer() {},
    sendToolResponse(id, name, result) {
      this.toolResponses.push({ id, name, result });
    },
    close() {
      this.isClosed = true;
    },
  };
}

/**
 * A session at the moment of pickup: the greeting was requested during ringing and
 * the server has already consumed Twilio's `start` event (which is why the bridge
 * itself never sees one) and stamped the stream on the session.
 */
function pickedUpSession(overrides = {}) {
  const session = createSession({ from: "+15550000000", to: "+15551111111" });
  session.preGeneratedGreetingRequestedAt = new Date().toISOString();
  session.mediaStreamStartedAt = new Date().toISOString();
  session.streamSid = STREAM_SID;
  session.status = "in_progress";
  Object.assign(session, overrides);
  return session;
}

function startBridge(session, gemini, twilioWs) {
  return new MediaStreamsBridge({
    twilioWs,
    callId: session.id,
    session,
    apiKey: "test-key",
    geminiConfig: {},
    systemInstruction: "test",
    preConnectedGemini: gemini,
  });
}

function events(session, type) {
  return session.fullTranscript.filter((e) => e.type === type);
}

function eventIndex(session, type) {
  return session.fullTranscript.findIndex((e) => e.type === type);
}

function useMockTimers(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

test("greeting audio that arrives after pickup queues behind the buffered opening", (t) => {
  useMockTimers(t);
  const head = [pcmChunk(1000), pcmChunk(2000)];
  const tail = pcmChunk(3000);
  const session = pickedUpSession({
    preGeneratedGreetingAudio: [...head],
    preGeneratedGreetingAudioChunks: head.length,
    preGeneratedGreetingTranscriptParts: ["Hi, this is Fred's assistant.", " Do you have"],
  });
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  // The tail of the same in-flight greeting turn, arriving before the flush.
  gemini.callbacks.onAudio(tail);
  gemini.callbacks.onTranscript("local", " a moment?");

  assert.deepEqual(twilioWs.mediaPayloads(), [], "held greeting must not reach Twilio early");

  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  gemini.callbacks.onGenerationComplete();

  assert.deepEqual(
    twilioWs.mediaPayloads(),
    [...head, tail].map(geminiToTwilio),
    "greeting must play opening-first, tail last",
  );

  const speech = events(session, "speech");
  assert.equal(speech.length, 1, "the greeting is one turn, not a split pair");
  assert.equal(speech[0].text, "Hi, this is Fred's assistant. Do you have a moment?");

  const generated = events(session, "outbound_turn_generated");
  assert.equal(generated.length, 1);
  assert.equal(generated[0].turn_id, "outbound_turn_1");

  assert.ok(
    eventIndex(session, "initial_greeting_requested") < eventIndex(session, "first_outbound_audio"),
    "no outbound audio before the greeting flush",
  );
  // "pre-generated" means "produced during ringing"; the latency report keys
  // "greeting wasn't ready at pickup" off this count.
  assert.equal(session.preGeneratedGreetingAudioChunks, head.length);

  bridge.cleanup();
  deleteSession(session.id);
});

test("a greeting that finished generating during ringing still gets finalized and marked", (t) => {
  useMockTimers(t);
  const session = pickedUpSession({
    preGeneratedGreetingAudio: [pcmChunk(1000)],
    preGeneratedGreetingAudioChunks: 1,
    preGeneratedGreetingTranscriptParts: ["Hi, this is Fred's assistant."],
    preGeneratedGreetingTurnComplete: true,
    preGeneratedGreetingTurnCompleteAt: new Date().toISOString(),
  });
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);

  const generated = events(session, "outbound_turn_generated");
  assert.equal(generated.length, 1, "no live completion signal is left to finalize this turn");
  assert.equal(generated[0].reason, "pre_generated_greeting");
  assert.ok(
    twilioWs.markNames().includes(`${generated[0].turn_id}_played`),
    "a finalized turn must be marked so playback can be tracked",
  );

  bridge.cleanup();
  deleteSession(session.id);
});

// The shape of the call in issue #100: generation completed 65ms before the flush.
test("a completion signal inside the handover window still finalizes the flushed turn", (t) => {
  useMockTimers(t);
  const head = [pcmChunk(1000)];
  const tail = pcmChunk(3000);
  const session = pickedUpSession({
    preGeneratedGreetingAudio: [...head],
    preGeneratedGreetingAudioChunks: head.length,
    preGeneratedGreetingTranscriptParts: ["Hi, this is Fred's assistant."],
  });
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  gemini.callbacks.onAudio(tail);
  // Both signals land while the greeting is still held — after this there is no
  // completion signal left for the turn the flush is about to create.
  gemini.callbacks.onGenerationComplete();
  gemini.callbacks.onTurnComplete();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);

  assert.deepEqual(twilioWs.mediaPayloads(), [...head, tail].map(geminiToTwilio));

  const generated = events(session, "outbound_turn_generated");
  assert.equal(generated.length, 1);
  assert.equal(generated[0].reason, "pre_generated_greeting");
  assert.ok(twilioWs.markNames().includes(`${generated[0].turn_id}_played`));

  bridge.cleanup();
  deleteSession(session.id);
});

test("a greeting turn that completed without audio falls back to asking for one", (t) => {
  useMockTimers(t);
  const session = pickedUpSession({
    preGeneratedGreetingTurnComplete: true,
    preGeneratedGreetingTurnCompleteAt: new Date().toISOString(),
  });
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);

  assert.equal(gemini.textTurns.length, 1, "a silent line must not be the outcome");
  assert.match(gemini.textTurns[0], /connected/);

  bridge.cleanup();
  deleteSession(session.id);
});

// send_dtmf swaps the TwiML, so the stream drops and a second bridge is built for
// a call that already greeted — it must not announce itself into a phone menu.
test("a reconnected stream mid-call does not greet again", (t) => {
  useMockTimers(t);
  const session = pickedUpSession({
    initialGreetingRequestedAt: new Date().toISOString(),
    firstOutboundAudioAt: new Date().toISOString(),
    preGeneratedGreetingTurnComplete: true,
  });
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);

  assert.deepEqual(gemini.textTurns, [], "an IVR reconnect must not trigger a fresh greeting");
  assert.deepEqual(twilioWs.mediaPayloads(), []);

  bridge.cleanup();
  deleteSession(session.id);
});

// Nothing has played inside the handover window, so an interrupt there is the
// callee speaking into a silent line — they still need to hear who is calling.
test("an interrupt inside the handover window still delivers the greeting", (t) => {
  useMockTimers(t);
  const head = [pcmChunk(1000)];
  const session = pickedUpSession({
    preGeneratedGreetingAudio: [...head],
    preGeneratedGreetingAudioChunks: head.length,
    preGeneratedGreetingTranscriptParts: ["Hi, this is Fred's assistant."],
    preGeneratedGreetingTurnComplete: true,
    preGeneratedGreetingTurnCompleteAt: new Date().toISOString(),
  });
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  gemini.callbacks.onInterrupted();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);

  assert.deepEqual(twilioWs.mediaPayloads(), head.map(geminiToTwilio));
  assert.deepEqual(gemini.textTurns, [], "must not force a second greeting over the callee");
  assert.equal(events(session, "speech").length, 1);

  bridge.cleanup();
  deleteSession(session.id);
});

// An interrupted turn gets no generation/turn-complete signal of its own, so the
// flush has nothing left to finalize the turn it creates.
test("an interrupt inside the window still finalizes the greeting turn", (t) => {
  useMockTimers(t);
  const head = [pcmChunk(1000)];
  const next = pcmChunk(4000);
  const session = pickedUpSession({
    preGeneratedGreetingAudio: [...head],
    preGeneratedGreetingAudioChunks: head.length,
    preGeneratedGreetingTranscriptParts: ["Hi, this is Fred's assistant."],
  });
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  gemini.callbacks.onInterrupted();
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);

  const greetingTurns = events(session, "outbound_turn_generated");
  assert.equal(greetingTurns.length, 1, "the flushed greeting must be finalized");
  assert.equal(greetingTurns[0].turn_id, "outbound_turn_1");

  // An abandoned turn is over but did not complete: reporting it as completed
  // would make the summary's greeting-generation timing measure an interrupt.
  assert.equal(session.preGeneratedGreetingTurnComplete, false);
  assert.equal(session.preGeneratedGreetingTurnCompleteAt, undefined);

  // The model's next turn must not be swallowed into the greeting's turn id.
  gemini.callbacks.onAudio(next);
  gemini.callbacks.onGenerationComplete();
  const allTurns = events(session, "outbound_turn_generated");
  assert.equal(allTurns.length, 2);
  assert.equal(allTurns[1].turn_id, "outbound_turn_2");

  bridge.cleanup();
  deleteSession(session.id);
});

test("transcript that leads the first audio chunk across the flush is not lost", (t) => {
  useMockTimers(t);
  const session = pickedUpSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  // Transcription arrives before any audio: the flush has nothing to play, so the
  // buffer is never drained and these words used to be dropped on the floor.
  gemini.callbacks.onTranscript("local", "Hi, this is Fred's assistant.");
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  // Gemini delivers audio before transcription within one message
  // (geminiLive.ts handleMessage), so use that order rather than a friendlier one.
  gemini.callbacks.onAudio(pcmChunk(1000));
  gemini.callbacks.onTranscript("local", " Do you have a moment?");
  bridge.cleanup(); // flushes the transcript batcher

  // The guarantee is no loss and correct order, not a single event: the
  // first_outbound_audio marker legitimately closes the batcher's pending turn
  // between the held words and their continuation.
  const spoken = events(session, "speech").map((e) => e.text);
  assert.equal(spoken.join(""), "Hi, this is Fred's assistant. Do you have a moment?");
  assert.deepEqual(session.preGeneratedGreetingTranscriptParts, [], "nothing left to be wiped");

  deleteSession(session.id);
});

test("end_call inside the handover window waits for the greeting to play", (t) => {
  useMockTimers(t);
  const head = [pcmChunk(1000)];
  const session = pickedUpSession({
    preGeneratedGreetingAudio: [...head],
    preGeneratedGreetingAudioChunks: head.length,
    preGeneratedGreetingTranscriptParts: ["Hi, this is Fred's assistant."],
    preGeneratedGreetingTurnComplete: true,
    preGeneratedGreetingTurnCompleteAt: new Date().toISOString(),
  });
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  gemini.callbacks.onToolCall("end_call", { reason: "done" }, "call-1");

  assert.equal(events(session, "call_ended").length, 0, "held audio is still owed to the callee");

  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  assert.deepEqual(twilioWs.mediaPayloads(), head.map(geminiToTwilio), "greeting must not be clipped");
  assert.equal(events(session, "call_ended").length, 0, "still waiting on playback confirmation");

  const [turn] = events(session, "outbound_turn_generated");
  twilioWs.sendTwilioEvent({ event: "mark", streamSid: STREAM_SID, mark: { name: `${turn.turn_id}_played` } });
  t.mock.timers.tick(PAST_HANGUP_GRACE_MS);

  assert.equal(events(session, "call_ended").length, 1, "hangup follows the drained greeting");
  assert.ok(
    eventIndex(session, "outbound_turn_played") < eventIndex(session, "call_ended"),
  );

  deleteSession(session.id);
});

// The window can be open with an empty buffer — the greeting is still generating.
// Hanging up then clips audio that is moments away.
test("end_call during the window waits for a greeting that has not been generated yet", (t) => {
  useMockTimers(t);
  const session = pickedUpSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  gemini.callbacks.onToolCall("end_call", { reason: "done" }, "call-1");
  // Grace expiry at 200ms, then the window closes at 350ms with nothing buffered.
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);
  assert.equal(events(session, "call_ended").length, 0, "greeting was still generating");

  // The greeting now streams in live, as the wait branch expects.
  gemini.callbacks.onAudio(pcmChunk(1000));
  t.mock.timers.tick(PAST_HANGUP_GRACE_MS);

  assert.equal(twilioWs.mediaPayloads().length, 1, "late greeting audio must still play");
  assert.equal(events(session, "call_ended").length, 0, "hangup waits on the new turn's mark");

  bridge.cleanup();
  deleteSession(session.id);
});

// end_call and an interrupt both inside the window: the greeting turn is abandoned
// and a hangup is already draining, so requesting a fresh greeting buys a turn
// nobody will hear.
test("a pending hangup skips the fallback greeting request", (t) => {
  useMockTimers(t);
  const session = pickedUpSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  bridge.sendInitialGreeting();
  gemini.callbacks.onInterrupted();
  gemini.callbacks.onToolCall("end_call", { reason: "done" }, "call-1");
  t.mock.timers.tick(PAST_GREETING_DELAY_MS);

  assert.deepEqual(gemini.textTurns, [], "no greeting request while hanging up");
  assert.deepEqual(events(session, "initial_greeting_requested"), []);

  t.mock.timers.tick(PAST_HANGUP_GRACE_MS);
  assert.equal(events(session, "call_ended").length, 1, "the hangup still completes");

  bridge.cleanup();
  deleteSession(session.id);
});
