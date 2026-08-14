import {
  upsample8kTo24k,
  downsample24kTo8k,
  StreamingUpsampler8kTo24k,
  StreamingDownsampler24kTo8k,
} from '../../src/audio/resample';
import { generateSine, generateSilence } from '../../src/audio/tone';

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function correlation(a: Int16Array, b: Int16Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return normA === normB ? 1 : 0;
  return dot / Math.sqrt(normA * normB);
}

describe('resample', () => {
  it('preserves length ratios exactly', () => {
    expect(upsample8kTo24k(new Int16Array(160)).length).toBe(480);
    expect(downsample24kTo8k(new Int16Array(480)).length).toBe(160);
    expect(downsample24kTo8k(new Int16Array(481)).length).toBe(160); // trailing partial dropped
  });

  it('passes silence through exactly', () => {
    const silence = generateSilence(100, 8000);
    expect(Array.from(upsample8kTo24k(silence))).toEqual(new Array(silence.length * 3).fill(0));
    const silence24 = generateSilence(100, 24000);
    expect(Array.from(downsample24kTo8k(silence24))).toEqual(new Array(silence24.length / 3).fill(0));
  });

  it('passes DC through in the steady state (edges may ramp: real filters have transients)', () => {
    const dc = new Int16Array(300).fill(1234);
    const up = upsample8kTo24k(dc).slice(60, -60);
    expect(up.every((s) => Math.abs(s - 1234) <= 2)).toBe(true);
    const down = downsample24kTo8k(dc).slice(20, -20);
    expect(down.every((s) => Math.abs(s - 1234) <= 2)).toBe(true);
  });

  it('a 440Hz sine survives 8k->24k->8k round trip', () => {
    const original = generateSine({ frequencyHz: 440, durationMs: 200, sampleRate: 8000, amplitude: 0.5 });
    const roundTripped = downsample24kTo8k(upsample8kTo24k(original));
    expect(roundTripped.length).toBe(original.length);
    expect(correlation(original, roundTripped)).toBeGreaterThan(0.95);
  });

  it('a 440Hz sine survives 24k->8k->24k round trip', () => {
    const original = generateSine({ frequencyHz: 440, durationMs: 200, sampleRate: 24000, amplitude: 0.5 });
    const roundTripped = upsample8kTo24k(downsample24kTo8k(original));
    expect(correlation(original, roundTripped)).toBeGreaterThan(0.95);
  });

  it('rejects out-of-band energy instead of aliasing it into the voice band', () => {
    // 6kHz is inaudible on the phone but a naive decimator folds it to 2kHz,
    // which garbles speech. It must come out heavily attenuated.
    const tone = generateSine({ frequencyHz: 6000, durationMs: 200, sampleRate: 24000, amplitude: 0.5 });
    expect(rms(downsample24kTo8k(tone))).toBeLessThan(rms(tone) * 0.05);
  });

  it('passes in-band speech frequencies at ~unity gain', () => {
    for (const frequencyHz of [300, 1000, 2500]) {
      const tone = generateSine({ frequencyHz, durationMs: 200, sampleRate: 24000, amplitude: 0.5 });
      const ratio = rms(downsample24kTo8k(tone)) / rms(tone);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it('streaming downsampler is chunk-size invariant and length-stable', () => {
    const input = generateSine({ frequencyHz: 700, durationMs: 100, sampleRate: 24000, amplitude: 0.5 });
    const whole = new StreamingDownsampler24kTo8k().push(input);
    expect(whole.length).toBe(Math.ceil(input.length / 3));

    const ragged = new StreamingDownsampler24kTo8k();
    const pieces: number[] = [];
    for (let off = 0; off < input.length; ) {
      const take = Math.min(1 + ((off * 7) % 211), input.length - off); // ragged sizes incl. odd
      pieces.push(...ragged.push(input.subarray(off, off + take)));
      off += take;
    }
    expect(pieces).toEqual(Array.from(whole));
  });

  it('streaming upsampler is chunk-size invariant and yields 3 samples per input', () => {
    const input = generateSine({ frequencyHz: 700, durationMs: 100, sampleRate: 8000, amplitude: 0.5 });
    const whole = new StreamingUpsampler8kTo24k().push(input);
    expect(whole.length).toBe(input.length * 3);

    const ragged = new StreamingUpsampler8kTo24k();
    const pieces: number[] = [];
    for (let off = 0; off < input.length; off += 160) {
      pieces.push(...ragged.push(input.subarray(off, Math.min(off + 160, input.length))));
    }
    expect(pieces).toEqual(Array.from(whole));
  });
});
