/**
 * Sample-rate conversion between telephony audio (8kHz) and the OpenAI audio
 * APIs (24kHz). Both directions are exact 1:3 ratios and share one windowed-sinc
 * low-pass prototype (cutoff ~3.4kHz at 24kHz): decimation without a real
 * anti-alias filter folds all TTS energy above 4kHz into the voice band, which
 * is audible as garbling on the phone.
 */

/** Filter length; divisible by 3 so the upsampler splits into clean polyphase branches. */
const TAPS = 45;
const CUTOFF_HZ = 3400;
const WIDEBAND_RATE = 24000;
/** Group delay of the prototype in 24kHz samples (~0.9ms end-to-end). */
const DELAY = (TAPS - 1) / 2;

function designLowpass(): Float64Array {
  const h = new Float64Array(TAPS);
  const fc = CUTOFF_HZ / WIDEBAND_RATE;
  let sum = 0;
  for (let n = 0; n < TAPS; n++) {
    const k = n - DELAY;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (TAPS - 1));
    h[n] = sinc * hamming;
    sum += h[n]!;
  }
  // Unity DC gain.
  for (let n = 0; n < TAPS; n++) h[n] = h[n]! / sum;
  return h;
}

const LOWPASS = designLowpass();

function clampPcm16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

/**
 * Streaming 24kHz -> 8kHz decimator: low-pass then take every third sample,
 * keeping filter history across arbitrary-size chunks. Causal, so output lags
 * input by the filter's ~0.9ms group delay (irrelevant on a phone call).
 */
export class StreamingDownsampler24kTo8k {
  /** History (TAPS-1 samples) followed by not-yet-consumed input. */
  private buf = new Float64Array(TAPS - 1);
  /** Index into buf of the next output's center sample. */
  private center = TAPS - 1;

  push(pcm24k: Int16Array): Int16Array {
    const buf = new Float64Array(this.buf.length + pcm24k.length);
    buf.set(this.buf);
    for (let i = 0; i < pcm24k.length; i++) buf[this.buf.length + i] = pcm24k[i]!;

    const out: number[] = [];
    let center = this.center;
    while (center < buf.length) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += LOWPASS[k]! * buf[center - k]!;
      out.push(clampPcm16(acc));
      center += 3;
    }
    const keepFrom = center - (TAPS - 1);
    this.buf = buf.slice(keepFrom);
    this.center = center - keepFrom;
    return Int16Array.from(out);
  }
}

/**
 * Streaming 8kHz -> 24kHz interpolator: zero-stuff by 3 and low-pass (gain 3),
 * computed as three polyphase branches of the shared prototype. Keeps history
 * across chunks, so there are no seams at frame boundaries.
 */
export class StreamingUpsampler8kTo24k {
  private static readonly PHASE_TAPS = TAPS / 3;
  /** Last PHASE_TAPS-1 input samples. */
  private buf = new Float64Array(StreamingUpsampler8kTo24k.PHASE_TAPS - 1);

  push(pcm8k: Int16Array): Int16Array {
    const ptaps = StreamingUpsampler8kTo24k.PHASE_TAPS;
    const buf = new Float64Array(this.buf.length + pcm8k.length);
    buf.set(this.buf);
    for (let i = 0; i < pcm8k.length; i++) buf[this.buf.length + i] = pcm8k[i]!;

    const out = new Int16Array(pcm8k.length * 3);
    let w = 0;
    for (let n = ptaps - 1; n < buf.length; n++) {
      for (let p = 0; p < 3; p++) {
        let acc = 0;
        for (let j = 0; j < ptaps; j++) acc += LOWPASS[3 * j + p]! * buf[n - j]!;
        out[w++] = clampPcm16(3 * acc);
      }
    }
    this.buf = buf.slice(buf.length - (ptaps - 1));
    return out;
  }
}

/**
 * One-shot 8kHz -> 24kHz (delay-compensated, zero-padded at the edges).
 * Output is exactly 3x the input length.
 */
export function upsample8kTo24k(input: Int16Array): Int16Array {
  const out = new Int16Array(input.length * 3);
  for (let m = 0; m < out.length; m++) {
    let acc = 0;
    for (let k = 0; k < TAPS; k++) {
      const stuffed = m + DELAY - k;
      if (stuffed % 3 !== 0) continue;
      const q = stuffed / 3;
      if (q >= 0 && q < input.length) acc += LOWPASS[k]! * input[q]!;
    }
    out[m] = clampPcm16(3 * acc);
  }
  return out;
}

/**
 * One-shot 24kHz -> 8kHz (delay-compensated, zero-padded at the edges).
 * Trailing samples that don't fill a group of 3 are dropped, as before.
 */
export function downsample24kTo8k(input: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(input.length / 3));
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    for (let k = 0; k < TAPS; k++) {
      const q = 3 * i + DELAY - k;
      if (q >= 0 && q < input.length) acc += LOWPASS[k]! * input[q]!;
    }
    out[i] = clampPcm16(acc);
  }
  return out;
}
