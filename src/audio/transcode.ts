import alawmulaw from "alawmulaw";
const { mulaw } = alawmulaw;

/**
 * Decode mulaw-encoded bytes to linear PCM 16-bit samples.
 * Uses alawmulaw's batch decode: Uint8Array → Int16Array directly.
 */
export function mulawToPcm16(mulawBytes: Uint8Array): Int16Array {
  return mulaw.decode(mulawBytes);
}

/**
 * Encode PCM 16-bit samples to mulaw bytes.
 * Uses alawmulaw's batch encode: Int16Array → Uint8Array directly.
 */
export function pcm16ToMulaw(pcm: Int16Array): Uint8Array {
  return mulaw.encode(pcm);
}

/**
 * Linear interpolation resampler.
 * Maps each output sample to a fractional position in the input and interpolates.
 * Stateless — each chunk is resampled independently.
 */
export function resample(
  input: Int16Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLen = Math.round(input.length * (toRate / fromRate));
  const output = new Int16Array(outputLen);
  const lastIdx = input.length - 1;

  for (let i = 0; i < outputLen; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    if (idx >= lastIdx) {
      output[i] = input[lastIdx];
    } else {
      const frac = srcPos - idx;
      output[i] = Math.round(input[idx] + frac * (input[idx + 1] - input[idx]));
    }
  }

  return output;
}

/**
 * Full inbound pipeline: Twilio mulaw 8kHz → Gemini PCM 16-bit 16kHz.
 *
 * Input:  base64-encoded mulaw 8kHz (from Twilio Media Streams media.payload)
 * Output: base64-encoded PCM 16-bit 16kHz little-endian (for Gemini realtimeInput)
 */
export function twilioToGemini(base64Mulaw8k: string): string {
  const mulawBuf = Buffer.from(base64Mulaw8k, "base64");
  const mulawBytes = new Uint8Array(
    mulawBuf.buffer,
    mulawBuf.byteOffset,
    mulawBuf.byteLength,
  );
  const pcm8k = mulawToPcm16(mulawBytes);
  const pcm16k = resample(pcm8k, 8000, 16000);
  return Buffer.from(
    pcm16k.buffer,
    pcm16k.byteOffset,
    pcm16k.byteLength,
  ).toString("base64");
}

/**
 * Full outbound pipeline: Gemini PCM 16-bit 24kHz → Twilio mulaw 8kHz.
 *
 * Input:  base64-encoded PCM 16-bit 24kHz little-endian (from Gemini serverContent)
 * Output: base64-encoded mulaw 8kHz (for Twilio Media Streams media.payload)
 */
export function geminiToTwilio(base64Pcm24k: string): string {
  const pcmBuf = Buffer.from(base64Pcm24k, "base64");
  const pcm24k = new Int16Array(
    pcmBuf.buffer,
    pcmBuf.byteOffset,
    pcmBuf.byteLength / 2,
  );
  const pcm8k = resample(pcm24k, 24000, 8000);
  const mulawBytes = pcm16ToMulaw(pcm8k);
  return Buffer.from(
    mulawBytes.buffer,
    mulawBytes.byteOffset,
    mulawBytes.byteLength,
  ).toString("base64");
}
