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

function gapEvents(session) {
  return session.fullTranscript.filter((e) => e.type === "transcription_gap");
}

// Larger than TranscriptBatcher's internal silence timeout (800ms, not exported),
// so ticking this much flushes a pending turn.
const FLUSH_TIMEOUT_MS = 1000;

// call_257cce0c2810: a barge-in cleared the agent's audio, but the remote speech
// that caused it did not land in the transcript until 7.1s/11.4s later — a hole
// large enough for a real question to go missing without anything else in the call
// showing a fault.
test("a barge-in whose transcription lands well after the clear logs a transcription_gap", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onAudio(pcmSeconds(1));
  gemini.callbacks.onInterrupted();
  t.mock.timers.tick(7100);
  gemini.callbacks.onTranscript("remote", "can you tell me more about his experience?");

  assert.deepEqual(gapEvents(session).map((e) => [e.speaker, e.gap_ms]), [["remote", 7100]]);

  bridge.cleanup();
  deleteSession(session.id);
});

test("a barge-in whose transcription lands quickly does not log a transcription_gap", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onAudio(pcmSeconds(1));
  gemini.callbacks.onInterrupted();
  t.mock.timers.tick(500);
  gemini.callbacks.onTranscript("remote", "wait");

  assert.deepEqual(gapEvents(session), []);

  bridge.cleanup();
  deleteSession(session.id);
});

// An interrupt with nothing buffered to clear never appends audio_cleared at all
// (clearBufferedOutboundAudio no-ops), so there is no clear to measure a gap from —
// this must not be misread as an unbounded gap.
test("an interrupt with no buffered audio to clear never logs a transcription_gap", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onInterrupted();
  t.mock.timers.tick(20000);
  gemini.callbacks.onTranscript("remote", "hello?");

  assert.deepEqual(gapEvents(session), []);

  bridge.cleanup();
  deleteSession(session.id);
});

// The pending clear is consumed the moment the first remote speech resolves it, so
// a second remote turn later in the same call has nothing left to measure against.
test("a resolved clear does not produce a gap for a later, unrelated remote turn", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onAudio(pcmSeconds(1));
  gemini.callbacks.onInterrupted();
  t.mock.timers.tick(7100);
  gemini.callbacks.onTranscript("remote", "can you tell me more about his experience?");
  t.mock.timers.tick(FLUSH_TIMEOUT_MS);

  t.mock.timers.tick(20000);
  gemini.callbacks.onTranscript("remote", "hello, are you still there?");

  assert.deepEqual(gapEvents(session).map((e) => [e.speaker, e.gap_ms]), [["remote", 7100]]);

  bridge.cleanup();
  deleteSession(session.id);
});

// An intervening local turn does not reset the pending clear — the gap describes
// whether the callee's own words made it into the transcript, not whether the
// agent replied first — and the gap event must land immediately before the speech
// event it explains, not after it or interleaved with unrelated events.
test("a transcription_gap is appended immediately before the speech event it explains", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onAudio(pcmSeconds(1));
  gemini.callbacks.onInterrupted();
  gemini.callbacks.onTranscript("local", "let me answer that");
  t.mock.timers.tick(FLUSH_TIMEOUT_MS);
  t.mock.timers.tick(10000);
  gemini.callbacks.onTranscript("remote", "can you tell me more about his experience?");
  t.mock.timers.tick(FLUSH_TIMEOUT_MS);

  const types = session.fullTranscript.map((e) => e.type);
  const gapIndex = types.indexOf("transcription_gap");
  assert.notEqual(gapIndex, -1);
  assert.equal(types[gapIndex + 1], "speech");
  assert.equal(session.fullTranscript[gapIndex + 1].speaker, "remote");
  assert.equal(session.fullTranscript[gapIndex].gap_ms, FLUSH_TIMEOUT_MS + 10000);
  assert.equal(session.fullTranscript[gapIndex].ts, session.fullTranscript[gapIndex + 1].ts);

  bridge.cleanup();
  deleteSession(session.id);
});
