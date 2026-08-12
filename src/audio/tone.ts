/**
 * Synthetic signal generation, shared by the fake Twilio media client and the
 * DSP unit tests. All signals are mono PCM16.
 */

export interface SineOptions {
  frequencyHz: number;
  durationMs: number;
  sampleRate: number;
  /** Linear amplitude in [0, 1]; 1.0 = full scale. */
  amplitude: number;
}

export function generateSine(opts: SineOptions): Int16Array {
  const length = Math.round((opts.durationMs / 1000) * opts.sampleRate);
  const out = new Int16Array(length);
  const peak = Math.min(Math.max(opts.amplitude, 0), 1) * 32767;
  const omega = (2 * Math.PI * opts.frequencyHz) / opts.sampleRate;
  for (let i = 0; i < length; i++) {
    out[i] = Math.round(peak * Math.sin(omega * i));
  }
  return out;
}

export function generateSilence(durationMs: number, sampleRate: number): Int16Array {
  return new Int16Array(Math.round((durationMs / 1000) * sampleRate));
}

/** Convert a dB value (relative to full scale) to linear amplitude in [0, 1]. */
export function amplitudeFromDb(db: number): number {
  return Math.min(1, Math.pow(10, db / 20));
}

export function concatPcm(chunks: readonly Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
