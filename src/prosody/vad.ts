import { VOLUME_THRESHOLDS_DBFS } from './volume';

export interface VoicedInterval {
  startMs: number;
  endMs: number;
}

export type VadEvent =
  | { type: 'speech.started'; atMs: number }
  | { type: 'speech.stopped'; atMs: number; interval: VoicedInterval };

export interface VadOptions {
  /** Frames at/above this level count as voiced. */
  thresholdDbfs?: number;
  /** Consecutive voiced frames required to open an interval (default 3 = 60ms). */
  onsetFrames?: number;
  /** Consecutive silent frames required to close an interval (default 15 = 300ms). */
  offsetFrames?: number;
  frameMs?: number;
  /** Silent frames that close a raw burst (default 3 = 60ms); bursts feed choppiness. */
  burstGapFrames?: number;
}

/**
 * Energy-based voice activity detection over the media clock. Emits smoothed
 * voiced intervals (short gaps merged) and also tracks raw voiced "bursts"
 * with much finer gap tolerance, which the stutter choppiness heuristic uses.
 */
export class Vad {
  private readonly thresholdDbfs: number;
  private readonly onsetFrames: number;
  private readonly offsetFrames: number;
  private readonly frameMs: number;
  private readonly burstGapFrames: number;

  private state: 'silent' | 'voiced' = 'silent';
  private onsetCount = 0;
  private onsetStartMs = 0;
  private offsetCount = 0;
  private intervalStartMs = 0;
  private lastVoicedEndMs = 0;

  private burstActive = false;
  private burstStartMs = 0;
  private burstLastVoicedEndMs = 0;
  private burstSilentRun = 0;
  private completedBursts: VoicedInterval[] = [];

  constructor(opts: VadOptions = {}) {
    this.thresholdDbfs = opts.thresholdDbfs ?? VOLUME_THRESHOLDS_DBFS.silence;
    this.onsetFrames = opts.onsetFrames ?? 3;
    this.offsetFrames = opts.offsetFrames ?? 15;
    this.frameMs = opts.frameMs ?? 20;
    this.burstGapFrames = opts.burstGapFrames ?? 3;
  }

  pushFrame(dbfs: number, frameStartMs: number): VadEvent[] {
    const events: VadEvent[] = [];
    const voiced = dbfs >= this.thresholdDbfs;
    const frameEndMs = frameStartMs + this.frameMs;

    // Raw burst tracking (fine-grained, for choppiness).
    if (voiced) {
      if (!this.burstActive) {
        this.burstActive = true;
        this.burstStartMs = frameStartMs;
      }
      this.burstLastVoicedEndMs = frameEndMs;
      this.burstSilentRun = 0;
    } else if (this.burstActive) {
      this.burstSilentRun++;
      if (this.burstSilentRun >= this.burstGapFrames) {
        this.completedBursts.push({ startMs: this.burstStartMs, endMs: this.burstLastVoicedEndMs });
        this.burstActive = false;
        this.burstSilentRun = 0;
      }
    }

    // Smoothed interval state machine.
    if (this.state === 'silent') {
      if (voiced) {
        if (this.onsetCount === 0) this.onsetStartMs = frameStartMs;
        this.onsetCount++;
        if (this.onsetCount >= this.onsetFrames) {
          this.state = 'voiced';
          this.intervalStartMs = this.onsetStartMs;
          this.lastVoicedEndMs = frameEndMs;
          this.offsetCount = 0;
          events.push({ type: 'speech.started', atMs: this.onsetStartMs });
        }
      } else {
        this.onsetCount = 0;
      }
    } else {
      if (voiced) {
        this.lastVoicedEndMs = frameEndMs;
        this.offsetCount = 0;
      } else {
        this.offsetCount++;
        if (this.offsetCount >= this.offsetFrames) {
          this.state = 'silent';
          this.onsetCount = 0;
          events.push({
            type: 'speech.stopped',
            atMs: this.lastVoicedEndMs,
            interval: { startMs: this.intervalStartMs, endMs: this.lastVoicedEndMs },
          });
        }
      }
    }

    return events;
  }

  /** The in-progress voiced interval, if speech is currently active. */
  currentInterval(): VoicedInterval | null {
    if (this.state !== 'voiced') return null;
    return { startMs: this.intervalStartMs, endMs: this.lastVoicedEndMs };
  }

  /** Remove and return bursts completed since the last drain. */
  drainBursts(): VoicedInterval[] {
    const bursts = this.completedBursts;
    this.completedBursts = [];
    return bursts;
  }
}
