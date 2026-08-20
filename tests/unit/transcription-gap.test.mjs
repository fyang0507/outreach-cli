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
