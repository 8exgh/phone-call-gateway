import { TELEPHONY_SAMPLE_RATE } from './frames';

/**
 * DTMF (touch-tone) synthesis. Each key is the sum of one row and one column
 * frequency; played in-band into the call it drives IVR menus exactly like a
 * finger on the keypad. 'w' (or 'W') is a half-second pause, as in Twilio's
 * sendDigits convention.
 */

const KEY_FREQUENCIES: Record<string, readonly [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  A: [697, 1633],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  B: [770, 1633],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  C: [852, 1633],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
  D: [941, 1633],
};

export const DTMF_TONE_MS = 180;
export const DTMF_GAP_MS = 80;
export const DTMF_PAUSE_MS = 500;
/** Per-tone amplitude; the two tones sum, so keep headroom. */
const TONE_AMPLITUDE = 0.3;

export const DTMF_DIGITS_PATTERN = /^[0-9A-Da-d*#wW]+$/;

/** Expected playback duration of a digit string, for tests and pacing. */
export function dtmfDurationMs(digits: string): number {
  let ms = 0;
  for (const raw of digits) {
    ms += raw === 'w' || raw === 'W' ? DTMF_PAUSE_MS : DTMF_TONE_MS + DTMF_GAP_MS;
  }
  return ms;
}

/** Render a digit string as 8kHz PCM. Throws on characters outside 0-9 A-D * # w. */
export function generateDtmf(digits: string): Int16Array {
  const out = new Int16Array((dtmfDurationMs(digits) * TELEPHONY_SAMPLE_RATE) / 1000);
  let offset = 0;
  for (const raw of digits) {
    if (raw === 'w' || raw === 'W') {
      offset += (DTMF_PAUSE_MS * TELEPHONY_SAMPLE_RATE) / 1000;
      continue;
    }
    const key = raw.toUpperCase();
    const freqs = KEY_FREQUENCIES[key];
    if (!freqs) throw new Error(`not a DTMF key: "${raw}"`);
    const toneSamples = (DTMF_TONE_MS * TELEPHONY_SAMPLE_RATE) / 1000;
    for (let i = 0; i < toneSamples; i++) {
      const t = i / TELEPHONY_SAMPLE_RATE;
      const value =
        TONE_AMPLITUDE * Math.sin(2 * Math.PI * freqs[0] * t) +
        TONE_AMPLITUDE * Math.sin(2 * Math.PI * freqs[1] * t);
      out[offset + i] = Math.round(value * 32767);
    }
    offset += toneSamples + (DTMF_GAP_MS * TELEPHONY_SAMPLE_RATE) / 1000;
  }
  return out;
}
