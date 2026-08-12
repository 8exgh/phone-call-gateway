import { encode, decode, encodeSample, decodeSample, MULAW_SILENCE } from '../../src/audio/mulaw';

describe('mulaw codec', () => {
  it('decodes known reference bytes', () => {
    // Standard G.711 mu-law reference points (Sun g711.c convention):
    // bytes 0x00-0x7f are negative, 0x80-0xff positive.
    expect(decodeSample(0xff)).toBe(0); // +0
    expect(Math.abs(decodeSample(0x7f))).toBe(0); // -0
    expect(decodeSample(0xfe)).toBe(8); // smallest positive step
    expect(decodeSample(0x7e)).toBe(-8);
    expect(decodeSample(0x00)).toBe(-32124); // most negative
    expect(decodeSample(0x80)).toBe(32124); // most positive
  });

  it('encodes silence to the silence byte', () => {
    expect(encodeSample(0)).toBe(MULAW_SILENCE);
  });

  it('encode/decode round-trips within mu-law quantization error', () => {
    // Mu-law quantization step grows with magnitude: the error bound is half
    // the local segment step, which stays under magnitude/16 (plus a floor for
    // the smallest segment).
    for (let s = -32000; s <= 32000; s += 137) {
      const roundTripped = decodeSample(encodeSample(s));
      const bound = Math.max(16, Math.abs(s) / 16);
      expect(Math.abs(roundTripped - s)).toBeLessThanOrEqual(bound);
    }
  });

  it('decode is monotonic within each sign half', () => {
    // Negative half ascends from -32124 toward -0.
    for (let b = 0x00; b < 0x7f; b++) {
      expect(decodeSample(b)).toBeLessThan(decodeSample(b + 1));
    }
    // Positive half descends from +32124 toward +0.
    for (let b = 0x80; b < 0xff; b++) {
      expect(decodeSample(b)).toBeGreaterThan(decodeSample(b + 1));
    }
  });

  it('array encode/decode matches per-sample versions', () => {
    const pcm = new Int16Array([0, 1000, -1000, 32000, -32000, 42]);
    const encoded = encode(pcm);
    expect(Array.from(encoded)).toEqual(Array.from(pcm).map((s) => encodeSample(s)));
    const decoded = decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(encoded).map((b) => decodeSample(b)));
  });

  it('clamps beyond-clip input instead of overflowing', () => {
    expect(decodeSample(encodeSample(32767))).toBe(32124);
    expect(decodeSample(encodeSample(-32768))).toBe(-32124);
  });
});
