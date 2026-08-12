import { ProsodyAnalyzer } from '../../src/prosody/prosodyAnalyzer';
import { generateSine, generateSilence, concatPcm, amplitudeFromDb } from '../../src/audio/tone';
import type { VadEvent } from '../../src/prosody/vad';

const FRAME_SAMPLES = 160; // 20ms at 8kHz

function speech(durationMs: number, amplitude: number): Int16Array {
  return generateSine({ frequencyHz: 440, durationMs, sampleRate: 8000, amplitude });
}

/** Feed a full signal through the analyzer frame by frame on the media clock. */
function feed(analyzer: ProsodyAnalyzer, signal: Int16Array, startMs = 0): VadEvent[] {
  const events: VadEvent[] = [];
  for (let offset = 0; offset + FRAME_SAMPLES <= signal.length; offset += FRAME_SAMPLES) {
    const frame = signal.subarray(offset, offset + FRAME_SAMPLES);
    events.push(...analyzer.pushFrame(frame, startMs + (offset / FRAME_SAMPLES) * 20));
  }
  return events;
}

describe('ProsodyAnalyzer', () => {
  it('annotates a loud fast utterance', () => {
    const analyzer = new ProsodyAnalyzer();
    const signal = concatPcm([
      generateSilence(200, 8000),
      speech(2000, 0.4), // ~-11dBFS -> loud
      generateSilence(400, 8000),
    ]);
    const events = feed(analyzer, signal);
    expect(events).toEqual([
      { type: 'speech.started', atMs: 200 },
      { type: 'speech.stopped', atMs: 2200, interval: { startMs: 200, endMs: 2200 } },
    ]);

    // 10 words over 2000ms voiced = 300 WPM.
    const annotation = analyzer.annotate('one two three four five six seven eight nine ten', 0.9);
    expect(annotation.startMs).toBe(200);
    expect(annotation.endMs).toBe(2200);
    expect(annotation.pace).toEqual({ class: 'fast', wpm: 300 });
    expect(annotation.volume.class).toBe('loud');
    expect(annotation.volume.dbfs).toBeCloseTo(-11, 0);
    expect(annotation.stutter.detected).toBe(false);
    expect(annotation.confidence).toBe(0.9);
  });

  it('annotates a quiet slow utterance after a previous one', () => {
    const analyzer = new ProsodyAnalyzer();
    feed(analyzer, concatPcm([speech(1000, 0.4), generateSilence(400, 8000)]));
    analyzer.annotate('first segment here');

    const offsetMs = 1400;
    feed(
      analyzer,
      concatPcm([speech(3000, amplitudeFromDb(-34)), generateSilence(400, 8000)]),
      offsetMs,
    );
    // 3 words over 3000ms voiced = 60 WPM; -34dB amplitude ~ -37dBFS RMS -> whisper.
    const annotation = analyzer.annotate('please stop calling');
    expect(annotation.startMs).toBe(offsetMs);
    expect(annotation.endMs).toBe(offsetMs + 3000);
    expect(annotation.pace).toEqual({ class: 'calm', wpm: 60 });
    expect(annotation.volume.class).toBe('whisper');
  });

  it('flags choppy stuttered speech', () => {
    const analyzer = new ProsodyAnalyzer();
    const chunks: Int16Array[] = [];
    for (let i = 0; i < 6; i++) {
      chunks.push(speech(160, 0.3)); // short bursts...
      chunks.push(generateSilence(100, 8000)); // ...with 100ms gaps
    }
    chunks.push(generateSilence(400, 8000));
    const events = feed(analyzer, concatPcm(chunks));

    // 100ms gaps merge into a single VAD interval.
    expect(events.filter((e) => e.type === 'speech.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'speech.stopped')).toHaveLength(1);

    const annotation = analyzer.annotate('I I wa- want you to stop');
    expect(annotation.stutter.detected).toBe(true);
    expect(annotation.stutter.repetitions).toBe(1);
    expect(annotation.stutter.falseStarts).toBe(1);
    expect(annotation.stutter.choppiness).toBe(1);
  });

  it('handles a transcript with no voiced audio gracefully', () => {
    const analyzer = new ProsodyAnalyzer();
    feed(analyzer, generateSilence(1000, 8000));
    const annotation = analyzer.annotate('hm');
    expect(annotation.pace.wpm).toBeNull();
    expect(annotation.pace.class).toBe('normal');
    expect(annotation.startMs).toBe(1000);
    expect(annotation.endMs).toBe(1000);
  });
});
