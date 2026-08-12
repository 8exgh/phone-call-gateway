export type VolumeClass = 'whisper' | 'normal' | 'loud' | 'yell';
export type FrameVolumeClass = VolumeClass | 'silence';

/** Upper bound (exclusive) of each class band, in dBFS. */
export const VOLUME_THRESHOLDS_DBFS = {
  silence: -50,
  whisper: -35,
  normal: -18,
  loud: -8,
} as const;

export function classifyDbfs(dbfs: number): FrameVolumeClass {
  if (dbfs < VOLUME_THRESHOLDS_DBFS.silence) return 'silence';
  if (dbfs < VOLUME_THRESHOLDS_DBFS.whisper) return 'whisper';
  if (dbfs < VOLUME_THRESHOLDS_DBFS.normal) return 'normal';
  if (dbfs < VOLUME_THRESHOLDS_DBFS.loud) return 'loud';
  return 'yell';
}

/** Segment-level class: silence maps to the quietest speech class. */
export function classifySegmentDbfs(dbfs: number): VolumeClass {
  const cls = classifyDbfs(dbfs);
  return cls === 'silence' ? 'whisper' : cls;
}

export const VOLUME_HYSTERESIS_FRAMES = 5; // 100ms at 20ms frames

/**
 * Frame-stream classifier with hysteresis: a new class must persist for
 * VOLUME_HYSTERESIS_FRAMES consecutive frames before the reported class flips,
 * so levels hovering at a boundary don't flicker.
 */
export class VolumeTracker {
  private current: FrameVolumeClass | null = null;
  private candidate: FrameVolumeClass | null = null;
  private candidateCount = 0;

  constructor(private readonly hysteresisFrames: number = VOLUME_HYSTERESIS_FRAMES) {}

  push(dbfs: number): FrameVolumeClass {
    const cls = classifyDbfs(dbfs);
    if (this.current === null) {
      this.current = cls;
      return cls;
    }
    if (cls === this.current) {
      this.candidate = null;
      this.candidateCount = 0;
      return this.current;
    }
    if (cls === this.candidate) {
      this.candidateCount++;
    } else {
      this.candidate = cls;
      this.candidateCount = 1;
    }
    if (this.candidateCount >= this.hysteresisFrames) {
      this.current = cls;
      this.candidate = null;
      this.candidateCount = 0;
    }
    return this.current;
  }
}
