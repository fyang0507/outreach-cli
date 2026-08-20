import assert from "node:assert/strict";
import test from "node:test";

import { MediaStreamsBridge } from "../../dist/daemon/mediaStreamsBridge.js";
import { createSession, deleteSession } from "../../dist/daemon/sessions.js";

const STREAM_SID = "MZtest";

// send_dtmf and the hangup path both reach for the Twilio REST client when these
// are set; no test here needs a real request.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

function fakeTwilioWs() {
  const handlers = {};
  return {
    on(event, cb) {
      handlers[event] = cb;
    },
    sendTwilioEvent(msg) {
      handlers.message?.(JSON.stringify(msg));
    },
    send() {},
    close() {},
  };
}

function fakeGemini() {
  return {
    callbacks: null,
    toolResponses: [],
    isClosed: false,
    closeReason: undefined,
    rebindCallbacks(cbs) {
      this.callbacks = cbs;
    },
    sendAudio() {},
    sendTextTurn() {},
    steer() {},
    sendToolResponse(id, name, result) {
      this.toolResponses.push({ id, name, result });
    },
    close() {
      this.isClosed = true;
    },
  };
}

/** A call already in conversation, as it stands when the model presses a key. */
function midCallSession() {
  const session = createSession({ from: "+15550000000", to: "+15551111111" });
  session.status = "in_progress";
  session.streamSid = STREAM_SID;
  session.callSid = "CAtest";
  session.mediaStreamStartedAt = new Date().toISOString();
  session.initialGreetingRequestedAt = new Date().toISOString();
  session.fullTranscript.push({ type: "speech", speaker: "remote", text: "Press 1 for sales.", ts: new Date().toISOString() });
  return session;
}

function startBridge(session, gemini, twilioWs, onCleanup) {
  const bridge = new MediaStreamsBridge({
    twilioWs,
    callId: session.id,
    session,
    apiKey: "test-key",
    geminiConfig: {},
    systemInstruction: "test",
    preConnectedGemini: gemini,
    onCleanup,
  });
  session.bridge = bridge; // the server stamps this after construction
  return bridge;
}

test("a stream teardown awaiting a DTMF reconnect does not end or finalize the call", () => {
  const session = midCallSession();
  session.expectingStreamReconnect = true;
  let finalizeCalls = 0;
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs, () => { finalizeCalls += 1; });

  // Twilio drops the stream when the new TwiML is applied.
  twilioWs.sendTwilioEvent({ event: "stop" });

  assert.equal(finalizeCalls, 0, "finalizing here would freeze the transcript at the DTMF");
  assert.equal(session.status, "in_progress", "the call is still up, playing digits");
  assert.equal(session.fullTranscript.length, 1, "history stays on the session for the next bridge");
  assert.ok(gemini.isClosed, "this bridge's Gemini session is still torn down");
  assert.ok(
    !session.fullTranscript.some((e) => e.type === "call_ended"),
    "a DTMF reconnect is not the end of the call",
  );

  deleteSession(session.id);
});

test("an ordinary stream teardown still ends and finalizes the call", () => {
  const session = midCallSession();
  let finalizeCalls = 0;
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  startBridge(session, gemini, twilioWs, () => { finalizeCalls += 1; });

  twilioWs.sendTwilioEvent({ event: "stop" });

  assert.equal(finalizeCalls, 1);
  assert.equal(session.status, "ended");
  const callEndedEvents = session.fullTranscript.filter((e) => e.type === "call_ended");
  assert.equal(callEndedEvents.length, 1, "a Twilio-initiated teardown must still leave a call_ended event");

  deleteSession(session.id);
});

test("cleanup() does not double up call_ended when a hangup path already appended one", () => {
  const session = midCallSession();
  let finalizeCalls = 0;
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs, () => { finalizeCalls += 1; });

  // Simulates forceHangup/handleCallHangup, both of which append call_ended
  // themselves before calling cleanup().
  session.fullTranscript.push({
    type: "call_ended",
    ts: new Date().toISOString(),
    reason: "hangup command",
    duration_ms: 1000,
  });

  bridge.cleanup();

  assert.equal(finalizeCalls, 1);
  assert.equal(session.status, "ended");
  const callEndedEvents = session.fullTranscript.filter((e) => e.type === "call_ended");
  assert.equal(callEndedEvents.length, 1, "cleanup() must reuse the existing call_ended, not append a second");
  assert.equal(callEndedEvents[0].reason, "hangup command", "the original, more specific reason must survive");

  deleteSession(session.id);
});

// The replacement stream can land before the old bridge's teardown runs.
test("a superseded bridge leaves the call to the newer bridge", () => {
  const session = midCallSession();
  let finalizeCalls = 0;
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs, () => { finalizeCalls += 1; });

  const newerBridge = { marker: "newer" };
  session.bridge = newerBridge;
  session.expectingStreamReconnect = false; // the server cleared it on the new start
  bridge.cleanup();

  assert.equal(finalizeCalls, 0, "the newer bridge owns the call end");
  assert.equal(session.status, "in_progress");
  assert.equal(session.bridge, newerBridge, "a dead bridge must not unhook the live one");

  deleteSession(session.id);
});

test("a DTMF that could not be sent leaves the call finalizable", () => {
  const session = midCallSession();
  let finalizeCalls = 0;
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs, () => { finalizeCalls += 1; });

  // No Twilio credentials, so the request is never made and no stream will return.
  gemini.callbacks.onToolCall("send_dtmf", { digits: "1" }, "call-1");
  assert.ok(!session.expectingStreamReconnect, "nothing was asked of Twilio");
  assert.equal(gemini.toolResponses.at(-1).result.error, "Missing credentials");

  bridge.cleanup();
  assert.equal(finalizeCalls, 1, "the transcript must still be written");
  assert.equal(session.status, "ended");

  deleteSession(session.id);
});
