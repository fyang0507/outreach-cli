import assert from "node:assert/strict";
import test from "node:test";

import { deleteSession } from "../../dist/daemon/sessions.js";
import {
  ACTIVITY_LOOKBACK_MS,
  LOCAL_SPEAKING_WINDOW_MS,
  computeActivity,
  isLocalSpeaking,
  remoteAudioOnLine,
} from "../../dist/daemon/callActivity.js";
import {
  answeredSession,
  fakeGemini,
  fakeTwilioWs,
  pcmSeconds,
  startBridge,
} from "./helpers/bridgeHarness.mjs";

// The raw presence of an in-flight outbound turn can't be trusted: it is only
// cleared once Twilio's mark comes back, and a lost mark (stream stall,
// reconnect, dropped message) would otherwise read `speaking: true` for the
// rest of the call. Recency has to flip it on its own, with no mark involved.
test("local.speaking flips to false once a turn's audio ages out, even if its mark never returns", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onAudio(pcmSeconds(1));

  assert.equal(
    isLocalSpeaking(bridge.activeOutboundTurnLastAudioAtMs(), Date.now()),
    true,
    "audio just arrived, well inside the speaking window",
  );

  t.mock.timers.tick(LOCAL_SPEAKING_WINDOW_MS + 1);

  assert.equal(twilioWs.sent.some((m) => m.event === "mark"), true, "sanity check: a mark was sent to Twilio");
  assert.equal(
    isLocalSpeaking(bridge.activeOutboundTurnLastAudioAtMs(), Date.now()),
    false,
    "no further audio arrived, and no mark ever came back from Twilio to clear the turn",
  );

  bridge.cleanup();
  deleteSession(session.id);
});

test("remote.audio_on_line reads unknown before any RMS activity has ever been recorded", () => {
  assert.equal(remoteAudioOnLine(undefined, Date.now()), "unknown");
});

test("remote.audio_on_line reads recent through a thinking-pause-sized gap", () => {
  const now = Date.now();
  const lastActivity = new Date(now - 3500).toISOString();
  assert.equal(remoteAudioOnLine(lastActivity, now), "recent");
});

test("remote.audio_on_line reads quiet once the gap exceeds ACTIVITY_LOOKBACK_MS", () => {
  const now = Date.now();
  const lastActivity = new Date(now - (ACTIVITY_LOOKBACK_MS + 1)).toISOString();
  assert.equal(remoteAudioOnLine(lastActivity, now), "quiet");
});

test("computeActivity reports null last_turn_ms_ago for a side that has never flushed a turn", () => {
  const now = Date.now();
  const snapshot = computeActivity(
    { lastRemoteTurnFlushedAt: undefined, lastLocalTurnFlushedAt: undefined, lastRemoteAudioActivityAt: undefined },
    null,
    now,
  );
  assert.deepEqual(snapshot, {
    remote: { last_turn_ms_ago: null, audio_on_line: "unknown" },
    local: { last_turn_ms_ago: null, speaking: false },
  });
});

test("computeActivity reports elapsed time since each side's last flushed turn independently", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onTranscript("remote", "hello there");
  bridge.cleanup(); // flushes the pending remote turn immediately, stamping lastRemoteTurnFlushedAt now
  t.mock.timers.tick(1000);

  const now = Date.now();
  const snapshot = computeActivity(session, null, now);
  assert.equal(snapshot.remote.last_turn_ms_ago, 1000);
  assert.equal(snapshot.local.last_turn_ms_ago, null, "local never spoke");

  deleteSession(session.id);
});
