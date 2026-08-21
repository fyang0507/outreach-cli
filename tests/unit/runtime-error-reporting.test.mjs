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

// endTwilioCall reaches for the Twilio REST client when these are set; none of the
// assertions below need it, and a real client would outlive the test.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

function runtimeErrors(session) {
  return session.fullTranscript.filter((e) => e.type === "runtime_error");
}

function callEnded(session) {
  return session.fullTranscript.find((e) => e.type === "call_ended");
}

test("Gemini onerror logs a non-fatal runtime_error and does not hang up the call on its own", () => {
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  startBridge(session, gemini, twilioWs);

  gemini.callbacks.onError("socket hiccup");

  const errors = runtimeErrors(session);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].subsystem, "gemini");
  assert.equal(errors[0].fatal, false);
  assert.equal(errors[0].message, "socket hiccup");
  assert.equal(callEnded(session), undefined, "an onerror alone must not end the call");

  deleteSession(session.id);
});

test("Twilio WS onerror logs a non-fatal runtime_error and does not hang up the call on its own", () => {
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  startBridge(session, gemini, twilioWs);

  const err = new Error("ECONNRESET");
  twilioWs.emit("error", err);

  const errors = runtimeErrors(session);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].subsystem, "twilio_ws");
  assert.equal(errors[0].fatal, false);
  assert.equal(errors[0].message, "ECONNRESET");
  assert.equal(callEnded(session), undefined, "an onerror alone must not end the call");

  deleteSession(session.id);
});

test("an unexpected Gemini end after audio already played is a fatal runtime_error, and the call is hung up", () => {
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  startBridge(session, gemini, twilioWs);

  // Audio already reached the callee before Gemini's session dies. Finalizing
  // the turn and confirming Twilio's mark came back matters here: an outbound
  // turn still pending playback would itself hit the unrelated
  // pendingOutboundTurn() branch of handleGeminiEnd, which this test isn't about.
  gemini.callbacks.onAudio(pcmSeconds(1));
  gemini.callbacks.onGenerationComplete();
  const [turn] = turnEvents(session);
  twilioWs.sendTwilioEvent({ event: "mark", mark: { name: `${turn.turn_id}_played` } });
  assert.ok(session.firstOutboundAudioAt, "sanity check: audio already played");

  gemini.closeReason = "quota exhausted";
  gemini.callbacks.onEnd();

  const errors = runtimeErrors(session);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].subsystem, "gemini");
  assert.equal(errors[0].fatal, true);
  assert.equal(errors[0].message, "quota exhausted");

  const ended = callEnded(session);
  assert.ok(ended, "the call must be hung up once Gemini's session dies unexpectedly");
  assert.match(ended.reason, /Gemini unavailable: quota exhausted/);

  deleteSession(session.id);
});

test("an unexpected Gemini end with no audio ever played is still a fatal runtime_error that hangs up the call", () => {
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  startBridge(session, gemini, twilioWs);

  assert.equal(session.firstOutboundAudioAt, undefined, "sanity check: no audio ever played");

  gemini.closeReason = "invalid API key";
  gemini.callbacks.onEnd();

  const errors = runtimeErrors(session);
  assert.equal(errors.length, 1, "this used to be a preconnect_failed event; it is now runtime_error");
  assert.equal(errors[0].subsystem, "gemini");
  assert.equal(errors[0].fatal, true);
  assert.equal(errors[0].message, "invalid API key");
  assert.equal(
    session.fullTranscript.some((e) => e.type === "preconnect_failed"),
    false,
    "handleGeminiEnd no longer appends preconnect_failed",
  );

  const ended = callEnded(session);
  assert.ok(ended, "the call must still be hung up");
  assert.match(ended.reason, /Gemini unavailable: invalid API key/);

  deleteSession(session.id);
});

test("a pendingHangup already in flight when Gemini ends does not append a runtime_error", (t) => {
  // Mock timers so tryDrainPendingHangup's grace-period setTimeout (fired from the
  // pendingHangup branch this test exercises) never actually runs; the assertion
  // below only cares about what handleGeminiEnd does synchronously.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  // Simulate a hangup already in progress (agent-initiated wrap-up) by directly
  // setting the bridge's pendingHangup flag the same way tryDrainPendingHangup's
  // guard checks it — the exact shape of pendingHangup is an internal scheduling
  // detail, so we drive it through the same private state the bridge itself reads.
  bridge.pendingHangup = { timeout: setTimeout(() => {}, 1e9), reason: "wrap_up", source: "agent" };

  gemini.closeReason = "session ended mid-drain";
  gemini.callbacks.onEnd();

  assert.equal(
    runtimeErrors(session).length,
    0,
    "the pendingHangup/pendingOutboundTurn early return must not append a runtime_error",
  );

  deleteSession(session.id);
});
