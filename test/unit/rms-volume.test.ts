import { rmsDbfs, SILENCE_FLOOR_DBFS } from '../../src/prosody/rms';
import { classifyDbfs, classifySegmentDbfs, VolumeTracker } from '../../src/prosody/volume';
import { generateSine, generateSilence } from '../../src/audio/tone';

function sineFrameDbfs(amplitude: number): number {
  // 100ms is plenty for a stable RMS estimate.
  return rmsDbfs(generateSine({ frequencyHz: 440, durationMs: 100, sampleRate: 8000, amplitude }));
}

describe('rms', () => {
  it('silence reports the floor', () => {
    expect(rmsDbfs(generateSilence(20, 8000))).toBe(SILENCE_FLOOR_DBFS);
    expect(rmsDbfs(new Int16Array(0))).toBe(SILENCE_FLOOR_DBFS);
  });

  it('a sine reports amplitude minus ~3dB (crest factor)', () => {
    // RMS of a sine = amplitude / sqrt(2) -> dBFS = 20*log10(a) - 3.01
    expect(sineFrameDbfs(1.0)).toBeCloseTo(-3.0, 0);
    expect(sineFrameDbfs(0.1)).toBeCloseTo(-23.0, 0);
  });

  it('scaling amplitude by 10x raises level by 20dB', () => {
    expect(sineFrameDbfs(0.5) - sineFrameDbfs(0.05)).toBeCloseTo(20, 0);
  });
});

describe('volume classification', () => {
  it('maps sine amplitudes to the expected classes', () => {
    expect(classifyDbfs(sineFrameDbfs(0.001))).toBe('silence'); // ~-63dBFS
    expect(classifyDbfs(sineFrameDbfs(0.02))).toBe('whisper'); // ~-37dBFS
    expect(classifyDbfs(sineFrameDbfs(0.1))).toBe('normal'); // ~-23dBFS
    expect(classifyDbfs(sineFrameDbfs(0.4))).toBe('loud'); // ~-11dBFS
    expect(classifyDbfs(sineFrameDbfs(0.9))).toBe('yell'); // ~-4dBFS
  });

  it('segment classification maps silence to whisper', () => {
    expect(classifySegmentDbfs(-80)).toBe('whisper');
    expect(classifySegmentDbfs(-20)).toBe('normal');
  });
});

describe('VolumeTracker hysteresis', () => {
  it('adopts the first class immediately', () => {
    const tracker = new VolumeTracker();
    expect(tracker.push(-25)).toBe('normal');
  });

  it('does not flicker when the level oscillates across a boundary', () => {
    const tracker = new VolumeTracker();
    tracker.push(-19); // normal
    for (let i = 0; i < 20; i++) {
      // Alternate +/-1dB around the normal/loud boundary at -18.
      expect(tracker.push(i % 2 === 0 ? -17 : -19)).toBe('normal');
    }
  });

  it('flips after the new class persists for the hysteresis window', () => {
    const tracker = new VolumeTracker();
    tracker.push(-25); // normal
    expect(tracker.push(-15)).toBe('normal');
    expect(tracker.push(-15)).toBe('normal');
    expect(tracker.push(-15)).toBe('normal');
    expect(tracker.push(-15)).toBe('normal');
    expect(tracker.push(-15)).toBe('loud'); // 5th consecutive loud frame
  });
});
