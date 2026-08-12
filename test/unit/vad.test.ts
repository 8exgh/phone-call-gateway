import { Vad, type VadEvent } from '../../src/prosody/vad';

const VOICED = -20;
const SILENT = -96;

/** Push a dbfs pattern (frame by frame, 20ms media clock) and collect events. */
function run(vad: Vad, pattern: Array<[level: number, frames: number]>): VadEvent[] {
  const events: VadEvent[] = [];
  let frame = 0;
  for (const [level, count] of pattern) {
    for (let i = 0; i < count; i++) {
      events.push(...vad.pushFrame(level, frame * 20));
      frame++;
    }
  }
  return events;
}

describe('Vad', () => {
  it('detects a single utterance with correct bounds', () => {
    const vad = new Vad();
    const events = run(vad, [
      [SILENT, 10], // 0..200ms
      [VOICED, 25], // 200..700ms
      [SILENT, 20], // 700ms..
    ]);
    expect(events).toEqual([
      { type: 'speech.started', atMs: 200 },
      { type: 'speech.stopped', atMs: 700, interval: { startMs: 200, endMs: 700 } },
    ]);
  });

  it('ignores a blip shorter than the onset window', () => {
    const vad = new Vad();
    const events = run(vad, [
      [SILENT, 5],
      [VOICED, 2], // 40ms < 60ms onset
      [SILENT, 20],
    ]);
    expect(events).toEqual([]);
  });

  it('merges gaps shorter than the offset window into one interval', () => {
    const vad = new Vad();
    const events = run(vad, [
      [SILENT, 5], // 0..100ms
      [VOICED, 10], // 100..300ms
      [SILENT, 10], // 200ms gap < 300ms offset
      [VOICED, 10], // 500..700ms
      [SILENT, 20],
    ]);
    expect(events).toEqual([
      { type: 'speech.started', atMs: 100 },
      { type: 'speech.stopped', atMs: 700, interval: { startMs: 100, endMs: 700 } },
    ]);
  });

  it('splits utterances separated by more than the offset window', () => {
    const vad = new Vad();
    const events = run(vad, [
      [VOICED, 10], // 0..200ms
      [SILENT, 20], // 400ms gap
      [VOICED, 10], // 600..800ms
      [SILENT, 20],
    ]);
    expect(events.map((e) => e.type)).toEqual([
      'speech.started',
      'speech.stopped',
      'speech.started',
      'speech.stopped',
    ]);
  });

  it('exposes the open interval while speech is active', () => {
    const vad = new Vad();
    run(vad, [[VOICED, 10]]);
    expect(vad.currentInterval()).toEqual({ startMs: 0, endMs: 200 });
    run(vad, [[SILENT, 20]]);
    expect(vad.currentInterval()).toBeNull();
  });

  it('tracks raw bursts with fine gap tolerance for choppiness', () => {
    const vad = new Vad();
    run(vad, [
      [VOICED, 8], // 0..160ms
      [SILENT, 5], // 100ms gap closes the burst (>= 60ms) but not the interval
      [VOICED, 8], // 260..420ms
      [SILENT, 20],
    ]);
    expect(vad.drainBursts()).toEqual([
      { startMs: 0, endMs: 160 },
      { startMs: 260, endMs: 420 },
    ]);
    expect(vad.drainBursts()).toEqual([]); // drained
  });
});
