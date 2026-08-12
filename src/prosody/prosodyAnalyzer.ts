import { rmsDbfs, dbfsFromMeanPower, sumSquaresNormalized, SILENCE_FLOOR_DBFS } from './rms';
import { Vad, type VadEvent, type VadOptions, type VoicedInterval } from './vad';
import { classifySegmentDbfs, VOLUME_THRESHOLDS_DBFS, type VolumeClass } from './volume';
import { countWords, computeWpm, classifyWpm, type PaceClass } from './pace';
import { analyzeStutter, type StutterResult } from './stutter';

export interface TranscriptAnnotation {
  text: string;
  startMs: number;
  endMs: number;
  pace: { class: PaceClass; wpm: number | null };
  volume: { class: VolumeClass; dbfs: number };
  stutter: StutterResult;
  confidence?: number;
}

/**
 * Per-call prosody state. Frames flow in continuously via pushFrame (returning
 * VAD events as they occur); when the transcriber completes a segment,
 * annotate() attributes all voiced audio accumulated since the previous
 * annotation to that segment and computes its prosody.
 *
 * All timestamps are on the media clock (Twilio frame count x 20ms) — never
 * wall clock — so results are deterministic and fakes can run faster than
 * realtime.
 */
export class ProsodyAnalyzer {
  private readonly vad: Vad;
  private readonly frameMs: number;
  private pendingIntervals: VoicedInterval[] = [];
  private pendingBursts: VoicedInterval[] = [];
  private voicedSumSquares = 0;
  private voicedSampleCount = 0;
  private lastMs = 0;
  /** End of the open interval already attributed to a previous annotation. */
  private consumedUpToMs = 0;

  constructor(opts: VadOptions = {}) {
    this.vad = new Vad(opts);
    this.frameMs = opts.frameMs ?? 20;
  }

  pushFrame(pcm8k: Int16Array, frameStartMs: number): VadEvent[] {
    const dbfs = rmsDbfs(pcm8k);
    this.lastMs = frameStartMs + this.frameMs;
    if (dbfs >= VOLUME_THRESHOLDS_DBFS.silence) {
      this.voicedSumSquares += sumSquaresNormalized(pcm8k);
      this.voicedSampleCount += pcm8k.length;
    }
    const events = this.vad.pushFrame(dbfs, frameStartMs);
    for (const event of events) {
      if (event.type === 'speech.stopped') {
        // Clip out any portion already attributed to an earlier annotation
        // (possible when a transcript completed while speech was ongoing).
        const startMs = Math.max(event.interval.startMs, this.consumedUpToMs);
        if (event.interval.endMs > startMs) {
          this.pendingIntervals.push({ startMs, endMs: event.interval.endMs });
        }
      }
    }
    this.pendingBursts.push(...this.vad.drainBursts());
    return events;
  }

  annotate(text: string, confidence?: number): TranscriptAnnotation {
    const intervals = this.pendingIntervals;
    this.pendingIntervals = [];

    const open = this.vad.currentInterval();
    if (open) {
      const startMs = Math.max(open.startMs, this.consumedUpToMs);
      if (open.endMs > startMs) intervals.push({ startMs, endMs: open.endMs });
      this.consumedUpToMs = open.endMs;
    }

    const bursts = this.pendingBursts;
    this.pendingBursts = [];

    const voicedMs = intervals.reduce((sum, i) => sum + (i.endMs - i.startMs), 0);
    const startMs = intervals.length > 0 ? intervals[0]!.startMs : this.lastMs;
    const endMs = intervals.length > 0 ? intervals[intervals.length - 1]!.endMs : this.lastMs;

    const wpm = computeWpm(countWords(text), voicedMs);

    const dbfs =
      this.voicedSampleCount > 0
        ? dbfsFromMeanPower(this.voicedSumSquares / this.voicedSampleCount)
        : SILENCE_FLOOR_DBFS;
    this.voicedSumSquares = 0;
    this.voicedSampleCount = 0;

    return {
      text,
      startMs,
      endMs,
      pace: { class: classifyWpm(wpm), wpm },
      volume: { class: classifySegmentDbfs(dbfs), dbfs: Number(dbfs.toFixed(1)) },
      stutter: analyzeStutter(text, bursts),
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
}
