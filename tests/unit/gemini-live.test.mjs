import assert from "node:assert/strict";
import test from "node:test";
import { Live } from "@google/genai";

import { GeminiLiveSession } from "../../dist/audio/geminiLive.js";

function geminiConfig() {
  return {
    model: "gemini-3.8-live",
    speech: { voice_name: "Aoede", language_code: null },
    generation: { temperature: null, top_p: null, top_k: null, max_output_tokens: null },
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
  const session = new GeminiLiveSession({
    apiKey: "test-key",
    geminiConfig: config,
    systemInstruction: "Help the caller complete their request.",
    onAudio() {},
    onTranscript() {},
    onToolCall() {},
    onEnd() {},
    ...callbacks,
  });
  t.after(() => session.close());
  await session.connect();
  return { request, session, sent };
}

test("Gemini 3.8 setup enables audio and transcripts without unsupported thinking controls", async (t) => {
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
  for (const key of ["thinkingConfig", "temperature", "topP", "topK", "maxOutputTokens"]) {
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
  config.generation = { temperature: 0, top_p: 0.8, top_k: 16, max_output_tokens: 512 };
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
  assert.equal(request.config.temperature, 0);
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
  assert.equal(Object.hasOwn(request.config, "thinkingConfig"), false);
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
