import assert from "node:assert/strict";
import test from "node:test";

import { deleteSession } from "../../dist/daemon/sessions.js";
import { isVoicemailSilence } from "../../dist/daemon/callGuards.js";
import {
  answeredSession,
  fakeGemini,
  fakeTwilioWs,
  startBridge,
} from "./helpers/bridgeHarness.mjs";

// A silence-level mu-law frame — enough to drive the real inbound-media path
// (transcode + RMS gating) without tripping REMOTE_AUDIO_RMS_THRESHOLD.
const MULAW_FRAME = Buffer.alloc(160, 0xff).toString("base64");
const FRAME_INTERVAL_MS = 500;
const MONOLOGUE_FRAMES = 200; // 100s of mocked time — past VOICEMAIL_SILENCE_MS (90s)

// G3's real motivating case: the callee holds the floor continuously. Real speech
// arrives as fast as someone talks, so nothing bounds how long a single turn can
// run — unlike the local/generated side, which is bounded by generation speed.
test("a long uninterrupted remote monologue does not trip the voicemail guard", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  for (let i = 0; i < MONOLOGUE_FRAMES; i += 1) {
    twilioWs.sendTwilioEvent({ event: "media", media: { payload: MULAW_FRAME } });
    gemini.callbacks.onTranscript("remote", "word ");
    t.mock.timers.tick(FRAME_INTERVAL_MS);
  }

  assert.ok(
    MONOLOGUE_FRAMES * FRAME_INTERVAL_MS > 90_000,
    "sanity check: the monologue ran past VOICEMAIL_SILENCE_MS",
  );
  const now = Date.now();
  assert.ok(
    now - session.lastTranscriptFragmentAt <= FRAME_INTERVAL_MS,
    "lastTranscriptFragmentAt advances on every fragment, independent of whether the batcher ever flushed",
  );
  assert.equal(
    isVoicemailSilence(session, now),
    false,
    "fragments kept arriving throughout the turn, so the guard must not fire",
  );

  bridge.cleanup();
  deleteSession(session.id);
});

// Proves D3 does not quietly defeat G3's real purpose: audio (hold music, a
// voicemail greeting) can keep the line "active" while Gemini's ASR produces
// nothing recognizable as speech, and that must still trip the guard.
test("true dead air with no transcript fragments still trips the voicemail guard", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  for (let i = 0; i < MONOLOGUE_FRAMES; i += 1) {
    twilioWs.sendTwilioEvent({ event: "media", media: { payload: MULAW_FRAME } });
    t.mock.timers.tick(FRAME_INTERVAL_MS);
  }

  const now = Date.now();
  assert.equal(
    isVoicemailSilence(session, now),
    true,
    "no transcript fragment ever arrived, so the guard must still fire",
  );

  bridge.cleanup();
  deleteSession(session.id);
});
