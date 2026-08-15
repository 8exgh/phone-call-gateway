import { generateDtmf, dtmfDurationMs, DTMF_TONE_MS, DTMF_GAP_MS, DTMF_PAUSE_MS } from '../../src/audio/dtmf';

/** Goertzel-style single-bin magnitude, normalized to the segment length. */
function toneMagnitude(samples: Int16Array, frequencyHz: number, sampleRate = 8000): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    const angle = (2 * Math.PI * frequencyHz * i) / sampleRate;
    re += samples[i]! * Math.cos(angle);
    im += samples[i]! * Math.sin(angle);
  }
  return Math.hypot(re, im) / samples.length;
}

describe('DTMF generation', () => {
  it('durations: tone+gap per key, half a second per w', () => {
    expect(dtmfDurationMs('5')).toBe(DTMF_TONE_MS + DTMF_GAP_MS);
    expect(dtmfDurationMs('1w2')).toBe(2 * (DTMF_TONE_MS + DTMF_GAP_MS) + DTMF_PAUSE_MS);
    expect(generateDtmf('1w2').length).toBe((dtmfDurationMs('1w2') * 8000) / 1000);
  });

  it('a key contains exactly its row and column frequencies', () => {
    const toneSamples = (DTMF_TONE_MS * 8000) / 1000;
    const five = generateDtmf('5').subarray(0, toneSamples); // 770 + 1336 Hz
    const present = [770, 1336].map((f) => toneMagnitude(five, f));
    const absent = [697, 941, 1209, 1477].map((f) => toneMagnitude(five, f));
    for (const p of present) for (const a of absent) expect(p).toBeGreaterThan(a * 10);
  });

  it('gaps and pauses are silent', () => {
    const audio = generateDtmf('1w');
    const gapStart = (DTMF_TONE_MS * 8000) / 1000;
    expect(audio.subarray(gapStart).every((s) => s === 0)).toBe(true);
  });

  it('rejects non-DTMF characters', () => {
    expect(() => generateDtmf('1E2')).toThrow('not a DTMF key');
  });
});
