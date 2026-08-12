export type PaceClass = 'calm' | 'slow' | 'normal' | 'fast';

/** Upper bound (exclusive) of each class band, in words per minute. */
export const PACE_THRESHOLDS_WPM = {
  calm: 85,
  slow: 115,
  normal: 165,
} as const;

/** Segments with less voiced time than this report wpm: null. */
export const MIN_VOICED_MS_FOR_WPM = 500;

export function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => /[a-z0-9]/i.test(t)).length;
}

export function computeWpm(wordCount: number, voicedMs: number): number | null {
  if (voicedMs < MIN_VOICED_MS_FOR_WPM || wordCount === 0) return null;
  return Math.round(wordCount / (voicedMs / 60000));
}

export function classifyWpm(wpm: number | null): PaceClass {
  if (wpm === null) return 'normal';
  if (wpm < PACE_THRESHOLDS_WPM.calm) return 'calm';
  if (wpm < PACE_THRESHOLDS_WPM.slow) return 'slow';
  if (wpm < PACE_THRESHOLDS_WPM.normal) return 'normal';
  return 'fast';
}
