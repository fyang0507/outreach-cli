import assert from "node:assert/strict";
import test from "node:test";
import { Live } from "@google/genai";

import { GeminiLiveSession } from "../../dist/audio/geminiLive.js";

function geminiConfig() {
  return {
    model: "gemini-3.8-live",
    speech: { voice_name: "Aoede", language_code: null },
    generation: { top_p: null, top_k: null, max_output_tokens: null },
    vad: {
      start_of_speech_sensitivity: null,
      end_of_speech_sensitivity: null,
      prefix_padding_ms: null,
      silence_duration_ms: null,
    },
    turn_taking: { activity_handling: "START_OF_ACTIVITY_INTERRUPTS" },
    transcription: { input_language_codes: null, output_language_codes: null },
  };
}

function createSession(config = geminiConfig(), callbacks = {}) {
  return new GeminiLiveSession({
    apiKey: "test-key",
    geminiConfig: config,
    systemInstruction: "Help the caller complete their request.",
    onAudio() {},
    onTranscript() {},
    onToolCall() {},
    onEnd() {},
    ...callbacks,
  });
}

async function connect(t, config = geminiConfig(), callbacks = {}) {
  let request;
  const sent = { content: [], realtime: [], tool: [] };
  t.mock.method(Live.prototype, "connect", async (payload) => {
    request = payload;
    return {
      sendClientContent: (payload) => sent.content.push(payload),
      sendRealtimeInput: (payload) => sent.realtime.push(payload),
      sendToolResponse: (payload) => sent.tool.push(payload),
      close() {},
    };
  });
  const session = createSession(config, callbacks);
  t.after(() => session.close());
  await session.connect();
  return { request, session, sent };
}

test("Gemini 3.8 setup enables audio, transcripts, and blocking call tools", async (t) => {
  const { request } = await connect(t);
  assert.equal(request.model, "gemini-3.8-live");
  assert.deepEqual(request.config.responseModalities, ["AUDIO"]);
  assert.equal(request.config.systemInstruction, "Help the caller complete their request.");
  assert.deepEqual(request.config.speechConfig, {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
  });
  assert.deepEqual(request.config.inputAudioTranscription, {});
  assert.deepEqual(request.config.outputAudioTranscription, {});
  assert.deepEqual(request.config.realtimeInputConfig, {
    activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  });
  for (const key of ["temperature", "topP", "topK", "maxOutputTokens"]) {
    assert.equal(Object.hasOwn(request.config, key), false, `${key} must be omitted`);
  }
  const declarations = request.config.tools.flatMap((tool) => tool.functionDeclarations);
  assert.deepEqual(declarations.map(({ name, behavior }) => ({ name, behavior })), [
    { name: "send_dtmf", behavior: "BLOCKING" },
    { name: "end_call", behavior: "BLOCKING" },
  ]);
});

test("Gemini setup preserves configured voice, generation, VAD, and transcription values", async (t) => {
  const config = geminiConfig();
  config.speech = { voice_name: "Kore", language_code: "en-US" };
  config.generation = { top_p: 0.8, top_k: 16, max_output_tokens: 512 };
  config.vad = {
    start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
    end_of_speech_sensitivity: "END_SENSITIVITY_LOW",
    prefix_padding_ms: 0,
    silence_duration_ms: 500,
  };
  config.turn_taking.activity_handling = "NO_INTERRUPTION";
  config.transcription = { input_language_codes: ["en", "es"], output_language_codes: ["en"] };
  const { request } = await connect(t, config);
  assert.deepEqual(request.config.speechConfig, {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    languageCode: "en-US",
  });
  assert.equal(Object.hasOwn(request.config, "temperature"), false);
  assert.equal(request.config.topP, 0.8);
  assert.equal(request.config.topK, 16);
  assert.equal(request.config.maxOutputTokens, 512);
  assert.deepEqual(request.config.realtimeInputConfig, {
    automaticActivityDetection: {
      startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
      endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
      prefixPaddingMs: 0,
      silenceDurationMs: 500,
    },
    activityHandling: "NO_INTERRUPTION",
  });
  assert.deepEqual(request.config.inputAudioTranscription, { languageCodes: ["en", "es"] });
  assert.deepEqual(request.config.outputAudioTranscription, { languageCodes: ["en"] });
});

test("explicit speech starts a user turn while steering stays on the realtime channel", async (t) => {
  const { session, sent } = await connect(t);
  session.sendTextTurn("Please introduce yourself.");
  session.steer("Briefly re-identify when the caller finishes speaking.");
  session.sendAudio("AQID");
  assert.deepEqual(sent.content, [{
    turns: [{ role: "user", parts: [{ text: "Please introduce yourself." }] }],
    turnComplete: true,
  }]);
  assert.deepEqual(sent.realtime, [
    { text: "Briefly re-identify when the caller finishes speaking." },
    { audio: { data: "AQID", mimeType: "audio/pcm;rate=16000" } },
  ]);
});

test("both blocking tool responses preserve the received function id and name", async (t) => {
  const received = [];
  const { request, session, sent } = await connect(t, geminiConfig(), {
    onToolCall: (name, args, id) => received.push({ name, args, id }),
  });
  const calls = [
    { name: "send_dtmf", args: { digits: "123#" }, id: "dtmf-request" },
    { name: "end_call", args: { reason: "Request completed" }, id: "hangup-request" },
  ];
  request.callbacks.onmessage({ toolCall: { functionCalls: calls } });
  assert.deepEqual(received, calls);
  for (const { id, name } of received) session.sendToolResponse(id, name, { ok: true });
  assert.deepEqual(sent.tool, calls.map(({ id, name }) => ({
    functionResponses: [{ id, name, response: { ok: true } }],
  })));
});

for (const event of ["error", "remote close", "local close"]) {
  test(`a pending setup rejects on ${event} and closes a late SDK session`, { timeout: 1000 }, async (t) => {
    let request;
    let finishSetup;
    let closedSessions = 0;
    const runtimeEvents = [];
    t.mock.method(Live.prototype, "connect", (payload) => {
      request = payload;
      return new Promise((resolve) => { finishSetup = resolve; });
    });
    const session = createSession(geminiConfig(), {
      onError: (message) => runtimeEvents.push(message),
      onEnd: () => runtimeEvents.push("ended"),
    });
    t.after(() => session.close());
    const connecting = session.connect();
    const rejection = assert.rejects(connecting, event === "local close" ? /closed before setup/ : /setup rejected/);
    if (event === "error") request.callbacks.onerror({ message: "setup rejected" });
    else if (event === "remote close") request.callbacks.onclose({ reason: "setup rejected" });
    else session.close();
    await rejection;
    assert.equal(session.isClosed, true);
    assert.deepEqual(runtimeEvents, [], "setup failure belongs to connect(), not runtime callbacks");
    if (event === "remote close") assert.equal(session.closeReason, "setup rejected");
    finishSetup({ close() { closedSessions += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closedSessions, 1, "a late SDK connection must not leak");
  });
}

test("established sessions preserve nonfatal errors and remote-close callbacks", async (t) => {
  const events = [];
  const { request, session } = await connect(t, geminiConfig(), {
    onError: (message) => events.push(message),
    onEnd: () => events.push("ended"),
  });
  request.callbacks.onerror({ message: "temporary transport error" });
  assert.equal(session.isClosed, false);
  request.callbacks.onclose({ reason: "server closed" });
  assert.equal(session.isClosed, true);
  assert.equal(session.closeReason, "server closed");
  assert.deepEqual(events, ["temporary transport error", "ended"]);
});
