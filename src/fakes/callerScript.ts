import { generateSine, generateSilence, concatPcm, amplitudeFromDb } from '../audio/tone';
import { TELEPHONY_SAMPLE_RATE } from '../audio/frames';

/**
 * A scripted caller, shared by the fake Twilio media client (which renders the
 * audio the "caller" speaks) and the fake transcriber (which emits the
 * matching text). Rendering uses real tones at the scripted level/duration, so
 * the actual prosody pipeline computes real volume/VAD/pace from them.
 */

export interface SpeakSpec {
  text: string;
  durationMs: number;
  /** Peak level in dB relative to full scale (default -25 ~ normal speech). */
  amplitudeDb?: number;
  frequencyHz?: number;
  /** Render as short bursts with gaps, to exercise the choppiness detector. */
  choppy?: boolean;
}

export type CallerScriptStep =
  | { speak: SpeakSpec }
  | { pauseMs: number }
  /**
   * Stream silence until one more gateway say has finished playing. Counts are
   * cumulative: the Nth wait step in a script waits for the Nth completed say,
   * which makes pacing deterministic regardless of timing.
   */
  | { waitForSayCompleted: true }
  /** Stream silence until the gateway has sent at least this much total audio (media-clock ms). */
  | { waitForAgentAudioMs: number }
  /** Press keypad keys: one dtmf event per character, as Twilio sends them. */
  | { pressDigits: string }
  | { hangup: true };

export type CallerScript = CallerScriptStep[];

export function scriptUtterances(script: CallerScript): string[] {
  const texts: string[] = [];
  for (const step of script) {
    if ('speak' in step) texts.push(step.speak.text);
  }
  return texts;
}

function hashText(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

const CHOPPY_BURST_MS = 160;
const CHOPPY_GAP_MS = 100;

/** Render a speak step as 8kHz PCM16. */
export function renderSpeak(spec: SpeakSpec): Int16Array {
  const amplitude = amplitudeFromDb(spec.amplitudeDb ?? -25);
  const frequencyHz = spec.frequencyHz ?? 250 + (hashText(spec.text) % 400);
  if (!spec.choppy) {
    return generateSine({
      frequencyHz,
      durationMs: spec.durationMs,
      sampleRate: TELEPHONY_SAMPLE_RATE,
      amplitude,
    });
  }
  const chunks: Int16Array[] = [];
  let voicedMs = 0;
  while (voicedMs < spec.durationMs) {
    const burstMs = Math.min(CHOPPY_BURST_MS, spec.durationMs - voicedMs);
    chunks.push(
      generateSine({ frequencyHz, durationMs: burstMs, sampleRate: TELEPHONY_SAMPLE_RATE, amplitude }),
    );
    voicedMs += burstMs;
    if (voicedMs < spec.durationMs) {
      chunks.push(generateSilence(CHOPPY_GAP_MS, TELEPHONY_SAMPLE_RATE));
    }
  }
  return concatPcm(chunks);
}

/** A generic conversation for mock-mode demos: answers, objects, then relents. */
export const defaultCallerScript: CallerScript = [
  { pauseMs: 300 },
  { waitForSayCompleted: true }, // listen to the agent's opening line first
  { speak: { text: 'Hello, who is this?', durationMs: 1600 } },
  { waitForSayCompleted: true },
  { pauseMs: 300 },
  {
    speak: {
      text: 'I I wa- want to know why you keep calling me!',
      durationMs: 2200,
      amplitudeDb: -12,
      choppy: true,
    },
  },
  { waitForSayCompleted: true },
  { pauseMs: 300 },
  { speak: { text: 'okay... fine. that sounds reasonable.', durationMs: 2600, amplitudeDb: -32 } },
  { waitForSayCompleted: true },
  { pauseMs: 500 },
  { hangup: true },
];
