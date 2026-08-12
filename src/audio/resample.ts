/**
 * Sample-rate conversion between telephony audio (8kHz) and the OpenAI audio
 * APIs (24kHz). Both directions are exact 1:3 ratios, so no fractional
 * resampling is needed.
 */

/** 8kHz -> 24kHz via linear interpolation (2 interpolated samples per input pair). */
export function upsample8kTo24k(input: Int16Array): Int16Array {
  const out = new Int16Array(input.length * 3);
  for (let i = 0; i < input.length; i++) {
    const s0 = input[i]!;
    const s1 = i + 1 < input.length ? input[i + 1]! : s0;
    const step = (s1 - s0) / 3;
    out[i * 3] = s0;
    out[i * 3 + 1] = Math.round(s0 + step);
    out[i * 3 + 2] = Math.round(s0 + 2 * step);
  }
  return out;
}

/**
 * 24kHz -> 8kHz by averaging each group of 3 samples. The mean acts as a cheap
 * anti-alias filter, adequate for the 300-3400Hz telephony band. Trailing
 * samples that don't fill a group of 3 are dropped.
 */
export function downsample24kTo8k(input: Int16Array): Int16Array {
  const outLength = Math.floor(input.length / 3);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const base = i * 3;
    out[i] = Math.round((input[base]! + input[base + 1]! + input[base + 2]!) / 3);
  }
  return out;
}
