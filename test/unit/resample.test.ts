import { upsample8kTo24k, downsample24kTo8k } from '../../src/audio/resample';
import { generateSine, generateSilence } from '../../src/audio/tone';

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

  it('passes DC through exactly', () => {
    const dc = new Int16Array(300).fill(1234);
    expect(upsample8kTo24k(dc).every((s) => s === 1234)).toBe(true);
    expect(downsample24kTo8k(dc).every((s) => s === 1234)).toBe(true);
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
});
