/**
 * G.711 mu-law codec. Twilio Media Streams carry audio as 8kHz mu-law; this
 * converts to/from linear PCM16 for DSP and for the OpenAI audio APIs.
 */

const BIAS = 0x84; // 132
const CLIP = 32635;

export function encodeSample(sample: number): number {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeSampleUncached(byte: number): number {
  const b = ~byte & 0xff;
  const sign = b & 0x80;
  const exponent = (b >> 4) & 0x07;
  const mantissa = b & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

const DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = decodeSampleUncached(i);
  }
  return table;
})();

export function decodeSample(byte: number): number {
  return DECODE_TABLE[byte & 0xff]!;
}

export function encode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = encodeSample(pcm[i]!);
  }
  return out;
}

export function decode(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = DECODE_TABLE[mulaw[i]!]!;
  }
  return out;
}

/** The mu-law byte representing silence (linear 0). */
export const MULAW_SILENCE = 0xff;
