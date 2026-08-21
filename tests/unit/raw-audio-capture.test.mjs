import assert from "node:assert/strict";
import test from "node:test";

import { buildMulawWav } from "../../dist/audio/wavWriter.js";
import { deleteSession } from "../../dist/daemon/sessions.js";
import {
  answeredSession,
  fakeGemini,
  fakeTwilioWs,
  pcmSeconds,
  startBridge,
  STREAM_SID,
} from "./helpers/bridgeHarness.mjs";

// D8: raw call audio is captured purely for record-keeping/audit — no STT, no
// analysis. This exercises the two capture points (inbound in
// handleTwilioMessage's "media" case, outbound in sendOutboundAudio) plus the
// pure WAV header builder in isolation.

test("buildMulawWav produces a spec-correct header", () => {
  const mulawBytes = Buffer.from([1, 2, 3, 4, 5]);
  const wav = buildMulawWav(mulawBytes);

  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8, "RIFF chunkSize excludes RIFF+chunkSize fields");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt32LE(16), 18, "subchunk1Size includes cbSize for non-PCM");
  assert.equal(wav.readUInt16LE(20), 7, "audioFormat: WAVE_FORMAT_MULAW");
  assert.equal(wav.readUInt16LE(22), 1, "numChannels");
  assert.equal(wav.readUInt32LE(24), 8000, "sampleRate");
  assert.equal(wav.readUInt32LE(28), 8000, "byteRate");
  assert.equal(wav.readUInt16LE(32), 1, "blockAlign");
  assert.equal(wav.readUInt16LE(34), 8, "bitsPerSample");
  assert.equal(wav.readUInt16LE(36), 0, "cbSize");
  assert.equal(wav.toString("ascii", 38, 42), "fact");
  assert.equal(wav.readUInt32LE(42), 4, "factChunkSize");
  assert.equal(wav.readUInt32LE(46), mulawBytes.length, "sampleLength");
  assert.equal(wav.toString("ascii", 50, 54), "data");
  assert.equal(wav.readUInt32LE(54), mulawBytes.length, "dataSize");
  assert.equal(wav.length, 58 + mulawBytes.length);
  assert.deepEqual(wav.subarray(58), mulawBytes);
});

test("buildMulawWav handles an empty buffer without throwing", () => {
  const wav = buildMulawWav(Buffer.alloc(0));

  assert.equal(wav.length, 58, "header only, no data");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(46), 0, "sampleLength");
  assert.equal(wav.readUInt32LE(54), 0, "dataSize");
});

test("inbound media frames land in session.remoteAudioChunks in order", (t) => {
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  const chunk1 = Buffer.from([10, 20, 30]).toString("base64");
  const chunk2 = Buffer.from([40, 50, 60]).toString("base64");
  twilioWs.sendTwilioEvent({ event: "media", streamSid: STREAM_SID, media: { payload: chunk1 } });
  twilioWs.sendTwilioEvent({ event: "media", streamSid: STREAM_SID, media: { payload: chunk2 } });

  assert.equal(session.remoteAudioChunks.length, 2);
  assert.deepEqual(session.remoteAudioChunks[0], Buffer.from([10, 20, 30]));
  assert.deepEqual(session.remoteAudioChunks[1], Buffer.from([40, 50, 60]));

  bridge.cleanup();
  deleteSession(session.id);
});

test("outbound audio lands in session.localAudioChunks matching what Twilio received", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const session = answeredSession();
  const gemini = fakeGemini();
  const twilioWs = fakeTwilioWs();
  const bridge = startBridge(session, gemini, twilioWs);

  gemini.callbacks.onAudio(pcmSeconds(0.5));
  t.mock.timers.tick(50);
  gemini.callbacks.onAudio(pcmSeconds(0.5));
  gemini.callbacks.onGenerationComplete();

  const sentMedia = twilioWs.sent.filter((m) => m.event === "media");
  assert.equal(session.localAudioChunks.length, sentMedia.length);
  assert.equal(session.localAudioChunks.length, 2);
  for (const [i, chunk] of session.localAudioChunks.entries()) {
    assert.deepEqual(chunk, Buffer.from(sentMedia[i].media.payload, "base64"));
  }

  bridge.cleanup();
  deleteSession(session.id);
});
