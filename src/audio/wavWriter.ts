// Mono, 8-bit, 8kHz: one byte per sample, 8 samples/ms.
export const MULAW_8K_BYTES_PER_MS = 8;

/**
 * Minimal, spec-correct mono WAV wrapping 8-bit mu-law 8kHz audio directly — no
 * transcoding. Built purely for record-keeping playback (see docs/plan/
 * call-monitoring-completeness.md D8): "fmt " uses WAVE_FORMAT_MULAW (7) and
 * carries the cbSize field a non-PCM format requires, and a "fact" chunk
 * carries the sample count, also required for non-PCM formats.
 */
export function buildMulawWav(mulawChunks: Buffer[]): Buffer {
  const dataSize = mulawChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(58);
  let offset = 0;

  header.write("RIFF", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(50 + dataSize, offset); // chunkSize = 58 - 8 + dataSize
  offset += 4;
  header.write("WAVE", offset, "ascii");
  offset += 4;

  header.write("fmt ", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(18, offset); // subchunk1Size (non-PCM: includes cbSize)
  offset += 4;
  header.writeUInt16LE(7, offset); // audioFormat: WAVE_FORMAT_MULAW
  offset += 2;
  header.writeUInt16LE(1, offset); // numChannels
  offset += 2;
  header.writeUInt32LE(8000, offset); // sampleRate
  offset += 4;
  header.writeUInt32LE(8000, offset); // byteRate = 8000 * 1 * 8 / 8
  offset += 4;
  header.writeUInt16LE(1, offset); // blockAlign
  offset += 2;
  header.writeUInt16LE(8, offset); // bitsPerSample
  offset += 2;
  header.writeUInt16LE(0, offset); // cbSize
  offset += 2;

  header.write("fact", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(4, offset); // factChunkSize
  offset += 4;
  header.writeUInt32LE(dataSize, offset); // sampleLength (1 byte/sample)
  offset += 4;

  header.write("data", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(dataSize, offset); // dataSize
  offset += 4;

  return Buffer.concat([header, ...mulawChunks]);
}
