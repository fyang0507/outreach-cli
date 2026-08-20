import assert from "node:assert/strict";
import test from "node:test";

import { deleteSession } from "../../dist/daemon/sessions.js";
import {
  answeredSession,
  fakeGemini,
  fakeTwilioWs,
  pcmSeconds,
  startBridge,
} from "./helpers/bridgeHarness.mjs";

function speechEvents(session) {
  return session.fullTranscript.filter((e) => e.type === "speech");
}

test("a speaker change flushes the prior turn tagged turn_change", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onTranscript("remote", "hello there");
  gemini.callbacks.onTranscript("local", "hi, how can I help?");

  const speech = speechEvents(session);
  assert.equal(speech.length, 1);
  assert.equal(speech[0].speaker, "remote");
  assert.equal(speech[0].text, "hello there");
  assert.equal(speech[0].flush_reason, "turn_change");

  bridge.cleanup();
  deleteSession(session.id);
});

// The mechanism D1 removes: there is no idle-timeout flush left, so a turn with
// no genuine boundary event stays buffered no matter how long it sits.
test("with no speaker change, interrupt, or structured event, a pending turn is never flushed by time alone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onTranscript("remote", "still talking...");
  t.mock.timers.tick(60_000);

  assert.equal(speechEvents(session).length, 0, "no timer exists to flush this turn");

  bridge.cleanup();

  const speech = speechEvents(session);
  assert.equal(speech.length, 1);
  assert.equal(speech[0].flush_reason, "call_ended");

  deleteSession(session.id);
});

// The unit test plan's D1 case: an interrupt mid-turn must flush explicitly and
// be tagged as such, not inherit "turn_change" from appendDirect's incidental
// flush inside clearBufferedOutboundAudio/finalizeActiveOutboundTurn.
test("an interrupt mid-turn produces a speech event tagged interrupted, not turn_change", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onAudio(pcmSeconds(1));
  gemini.callbacks.onTranscript("remote", "can you tell me about");
  gemini.callbacks.onInterrupted();

  const speech = speechEvents(session);
  assert.equal(speech.length, 1);
  assert.equal(speech[0].speaker, "remote");
  assert.equal(speech[0].flush_reason, "interrupted");

  bridge.cleanup();
  deleteSession(session.id);
});

// clearBufferedOutboundAudio and finalizeActiveOutboundTurn both early-return
// when there is no outbound audio in flight (outboundTurnsByMark empty, or no
// active turn at all) — so without handleInterrupted's own explicit flush, a
// remote turn interrupted with nothing of ours queued would never be flushed.
test("an interrupt mid-turn with no outbound audio in flight still flushes the pending turn", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onTranscript("remote", "hello?");
  gemini.callbacks.onInterrupted();

  const speech = speechEvents(session);
  assert.equal(speech.length, 1);
  assert.equal(speech[0].flush_reason, "interrupted");

  bridge.cleanup();
  deleteSession(session.id);
});
