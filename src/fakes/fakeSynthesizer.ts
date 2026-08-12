import type { SpeechSynthesizer, SynthesizeOptions } from '../speech/synthesizer';
import { generateSine } from '../audio/tone';
import { OPENAI_SAMPLE_RATE } from '../audio/frames';
import { countWords } from '../prosody/pace';

const MS_PER_WORD = 300;
const CHUNK_MS = 100;

function hashText(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Deterministic TTS: a sine tone whose duration is proportional to the word
 * count (300ms/word) and whose frequency derives from the text, so tests can
 * assert on outbound audio duration and energy.
 */
export class FakeSpeechSynthesizer implements SpeechSynthesizer {
  async *synthesize(text: string, opts?: SynthesizeOptions): AsyncIterable<Int16Array> {
    const words = Math.max(1, countWords(text));
    const audio = generateSine({
      frequencyHz: 300 + (hashText(text) % 500),
      durationMs: words * MS_PER_WORD,
      sampleRate: OPENAI_SAMPLE_RATE,
      amplitude: 0.3,
    });
    const chunkSamples = (OPENAI_SAMPLE_RATE / 1000) * CHUNK_MS;
    for (let offset = 0; offset < audio.length; offset += chunkSamples) {
      if (opts?.signal?.aborted) return;
      await new Promise((resolve) => setImmediate(resolve));
      yield audio.subarray(offset, Math.min(offset + chunkSamples, audio.length));
    }
  }
}

/** Expected playback duration of a fake-synthesized text, for test assertions. */
export function fakeSynthesisDurationMs(text: string): number {
  return Math.max(1, countWords(text)) * MS_PER_WORD;
}
