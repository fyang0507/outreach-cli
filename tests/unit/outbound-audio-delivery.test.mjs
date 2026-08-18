import assert from "node:assert/strict";
import test from "node:test";

import { deleteSession } from "../../dist/daemon/sessions.js";
import {
  answeredSession,
  fakeGemini,
  fakeTwilioWs,
  pcmSeconds,
  startBridge,
  turnEvents,
} from "./helpers/bridgeHarness.mjs";

// A turn's audio has to reach Twilio at least as fast as it plays. When it does
// not, Twilio's queue empties mid-sentence and the callee hears the gaps — the
// transcript alone cannot show that, because a stalled generation and a short
// reply look identical in it.
test("audio that arrives faster than it plays reports no starvation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  for (let i = 0; i < 3; i += 1) {
    gemini.callbacks.onAudio(pcmSeconds(0.5));
    t.mock.timers.tick(50);
  }
  gemini.callbacks.onGenerationComplete();

  const [turn] = turnEvents(session);
  assert.equal(turn.audio_ms, 1500, "three 500ms chunks");
  assert.equal(turn.stream_span_ms, 100, "delivered in 100ms of wall clock");
  assert.equal(turn.max_audio_gap_ms, 50);
  assert.equal(session.maxOutboundAudioStarvationMs, 0, "playback was never owed audio it did not have");
  assert.equal(session.maxOutboundAudioGapMs, 50);

  bridge.cleanup();
  deleteSession(session.id);
});

test("audio that trickles in slower than realtime is reported as starvation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  // 1500ms of speech spread over 4s of wall clock: 2.5s of that turn is silence
  // on the line, in gaps of up to 2s.
  gemini.callbacks.onAudio(pcmSeconds(0.5));
  t.mock.timers.tick(2000);
  gemini.callbacks.onAudio(pcmSeconds(0.5));
  t.mock.timers.tick(2000);
  gemini.callbacks.onAudio(pcmSeconds(0.5));
  gemini.callbacks.onGenerationComplete();

  const [turn] = turnEvents(session);
  assert.equal(turn.audio_ms, 1500);
  assert.equal(turn.stream_span_ms, 4000);
  assert.equal(turn.max_audio_gap_ms, 2000);
  assert.equal(session.maxOutboundAudioStarvationMs, 2500, "4000ms of wall clock for 1500ms of audio");
  assert.equal(session.maxOutboundAudioGapMs, 2000);

  bridge.cleanup();
  deleteSession(session.id);
});

// The worst turn is what matters, and it must survive later healthy turns.
test("the call keeps the worst turn's numbers, not the last turn's", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onAudio(pcmSeconds(0.5));
  t.mock.timers.tick(3000);
  gemini.callbacks.onAudio(pcmSeconds(0.5));
  gemini.callbacks.onGenerationComplete();

  gemini.callbacks.onAudio(pcmSeconds(1));
  t.mock.timers.tick(20);
  gemini.callbacks.onAudio(pcmSeconds(1));
  gemini.callbacks.onGenerationComplete();

  const turns = turnEvents(session);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].max_audio_gap_ms, 20, "the second turn was healthy");
  assert.equal(session.maxOutboundAudioGapMs, 3000, "but the call is judged by its worst turn");
  assert.equal(session.maxOutboundAudioStarvationMs, 2000);

  bridge.cleanup();
  deleteSession(session.id);
});
