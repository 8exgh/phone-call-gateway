/**
 * Energy-based voice detection that adapts to the line's background level, so
 * a steady hum (car, fan, crowd) is not mistaken for someone talking. Works on
 * 20ms frames of 8kHz PCM; the caller decides what silence lengths mean.
 *
 * The background level is the quietest the line has been over the last few
 * seconds: speech always dips back to the background between words and inside
 * them (every "t", "k", "p" is a moment of near-silence), steady noise never
 * drops below itself.
 */
export interface AdaptiveVadOptions {
  /** Never treat anything quieter than this (RMS) as speech. */
  minRms?: number;
  /** Speech must be this many times louder than the background level. */
  ratio?: number;
  /** Consecutive loud frames needed before speech is declared (3 = 60ms). */
  onsetFrames?: number;
  /** How far back the background level looks, in frames (150 = 3s). */
  windowFrames?: number;
}

/**
 * Frames listened to before anything is called speech (200ms): long enough to
 * hear what this line's background sounds like, so noise present from the
 * first moment of a call is not taken for someone talking.
 */
const WARMUP_FRAMES = 10;

export class AdaptiveVad {
  private readonly minRms: number;
  private readonly ratio: number;
  private readonly onsetFrames: number;
  private readonly window: number[];
  private windowAt = 0;
  private filled = 0;
  private floor = 0;
  private loudRun = 0;
  private speaking = false;
  private silenceFrames = 1e6;

  constructor(opts: AdaptiveVadOptions = {}) {
    this.minRms = opts.minRms ?? 220;
    this.ratio = opts.ratio ?? 3.5;
    this.onsetFrames = opts.onsetFrames ?? 3;
    this.window = new Array<number>(opts.windowFrames ?? 150).fill(0);
  }

  /** Background level estimate (RMS). */
  get noiseFloor(): number {
    return this.floor;
  }

  /** ms since the last loud frame (0 while someone is talking). */
  get silenceMs(): number {
    return this.silenceFrames * 20;
  }

  /** A loud frame has just arrived that may turn out to be the start of speech. */
  get maybeSpeech(): boolean {
    return this.loudRun > 0;
  }

  /** True from confirmed speech onset until endUtterance(). */
  get inSpeech(): boolean {
    return this.speaking;
  }

  /**
   * Feed one frame. Returns whether the frame itself is loud, and whether this
   * frame is the moment speech was confirmed to have started. Pass suppressed
   * for a frame that was blanked out (echo of our own voice).
   */
  push(pcm: Int16Array, suppressed = false): { loud: boolean; started: boolean } {
    if (suppressed) {
      // Blanked audio (our own echo) says nothing about the line's background level.
      this.loudRun = 0;
      this.silenceFrames++;
      return { loud: false, started: false };
    }
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
    const level = Math.sqrt(sum / Math.max(1, pcm.length));

    this.window[this.windowAt] = level;
    this.windowAt = (this.windowAt + 1) % this.window.length;
    if (this.filled < this.window.length) this.filled++;
    let min = Infinity;
    for (let i = 0; i < this.filled; i++) min = Math.min(min, this.window[i]!);
    this.floor = min;

    const loud = this.filled > WARMUP_FRAMES && level > Math.max(this.minRms, this.floor * this.ratio);
    if (loud) {
      this.loudRun++;
      this.silenceFrames = 0;
    } else {
      this.loudRun = 0;
      this.silenceFrames++;
    }

    let started = false;
    if (!this.speaking && this.loudRun >= this.onsetFrames) {
      this.speaking = true;
      started = true;
    }
    return { loud, started };
  }

  /** The current utterance has been dealt with: wait for a fresh onset. */
  endUtterance(): void {
    this.speaking = false;
    this.loudRun = 0;
  }
}
