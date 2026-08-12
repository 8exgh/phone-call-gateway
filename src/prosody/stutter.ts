import type { VoicedInterval } from './vad';

export interface StutterResult {
  detected: boolean;
  /** Extra occurrences in immediate word/bigram repetition runs ("I I I" -> 2). */
  repetitions: number;
  /** Cut-off tokens ("wa-") or short strict prefixes of the next word ("th the"). */
  falseStarts: number;
  /** Fraction of voiced bursts shorter than 300ms (0 when too few bursts to judge). */
  choppiness: number;
}

/** Filler words are hesitation, not stuttering; never flagged. */
const FILLERS = new Set(['um', 'uh', 'er', 'ah', 'hmm', 'mm', 'mhm']);

const SHORT_BURST_MS = 300;
const MIN_BURSTS_FOR_CHOPPINESS = 3;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((raw) => {
      // Strip punctuation but keep a trailing hyphen: it marks a cut-off word.
      const cutOff = /[a-z0-9]-$/.test(raw.replace(/[^a-z0-9-]/g, ''));
      const core = raw.replace(/[^a-z0-9']/g, '');
      return core.length > 0 ? (cutOff ? `${core}-` : core) : '';
    })
    .filter((t) => t.length > 0);
}

export function analyzeStutterText(text: string): { repetitions: number; falseStarts: number } {
  const tokens = tokenize(text);
  let repetitions = 0;
  let falseStarts = 0;

  // Immediate identical-word runs.
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1] && !FILLERS.has(tokens[i]!)) {
      repetitions++;
    }
  }

  // Immediate bigram repeats ("i want i want").
  for (let i = 0; i + 3 < tokens.length; i++) {
    if (
      tokens[i] === tokens[i + 2] &&
      tokens[i + 1] === tokens[i + 3] &&
      tokens[i] !== tokens[i + 1] // pure word runs are already counted above
    ) {
      repetitions++;
      i += 2;
    }
  }

  // False starts.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.endsWith('-') && token.length > 1) {
      falseStarts++;
      continue;
    }
    const next = tokens[i + 1];
    if (
      next !== undefined &&
      token.length >= 2 &&
      token.length <= 3 &&
      next.length > token.length &&
      next.startsWith(token) &&
      !FILLERS.has(token)
    ) {
      falseStarts++;
    }
  }

  return { repetitions, falseStarts };
}

export function choppiness(bursts: readonly VoicedInterval[]): number {
  if (bursts.length < MIN_BURSTS_FOR_CHOPPINESS) return 0;
  const short = bursts.filter((b) => b.endMs - b.startMs < SHORT_BURST_MS).length;
  return short / bursts.length;
}

export function analyzeStutter(text: string, bursts: readonly VoicedInterval[]): StutterResult {
  const textFeatures = analyzeStutterText(text);
  const chop = choppiness(bursts);
  return {
    ...textFeatures,
    choppiness: Number(chop.toFixed(2)),
    detected: textFeatures.repetitions > 0 || textFeatures.falseStarts > 0 || chop > 0.5,
  };
}
