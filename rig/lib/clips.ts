import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { config as dotenv } from 'dotenv';
import { downsample24kTo8k } from '../../src/audio/resample';
import { rms, trimSilence } from './audio';

// The shell may export a stale key; the project's .env is authoritative for the rig.
dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

const CACHE_DIR = join(__dirname, '..', '.cache');
const MODEL = 'gpt-4o-mini-tts';
export const CALLER_VOICE = 'ash';
const STYLE =
  'You are an ordinary person talking on the phone. Casual, natural, conversational pace. Not a narrator.';

/**
 * How the caller delivers a line. The TTS voice pauses about half a second at
 * every comma whatever it is told, which is a slow, deliberate talker. So the
 * same rendering is used for every style and the pauses inside it are trimmed:
 * "hesitant" keeps them (a caller thinking aloud), "natural" caps them at
 * ordinary conversational length, "urgent" all but removes them (cutting in).
 */
export type ClipStyle = 'natural' | 'hesitant' | 'urgent';
const MAX_PAUSE_MS: Record<ClipStyle, number> = { hesitant: Infinity, natural: 260, urgent: 100 };

/** Shorten every silence inside a clip to at most maxMs. */
function capPauses(pcm: Int16Array, maxMs: number): Int16Array {
  if (!Number.isFinite(maxMs)) return pcm;
  const win = 80; // 10ms
  const keep: boolean[] = [];
  const quiet: boolean[] = [];
  for (let i = 0; i + win <= pcm.length; i += win) quiet.push(rms(pcm, i, i + win) < 220);
  const maxWins = Math.round(maxMs / 10);
  for (let i = 0; i < quiet.length; ) {
    if (!quiet[i]) {
      keep.push(true);
      i++;
      continue;
    }
    let j = i;
    while (j < quiet.length && quiet[j]) j++;
    const run = j - i;
    const edge = i === 0 || j === quiet.length;
    for (let k = 0; k < run; k++) {
      // Keep the start and end of a long pause (speech tails off into it), drop the middle.
      keep.push(edge || run <= maxWins || k < maxWins / 2 || k >= run - maxWins / 2);
    }
    i = j;
  }
  const out = new Int16Array(keep.filter(Boolean).length * win);
  let o = 0;
  keep.forEach((k, idx) => {
    if (k) {
      out.set(pcm.subarray(idx * win, (idx + 1) * win), o);
      o += win;
    }
  });
  return out;
}

let client: OpenAI | null = null;

/** The caller's line as 8kHz PCM, rendered once by TTS and cached on disk. */
export async function getClip(text: string, style: ClipStyle = 'natural', voice = CALLER_VOICE): Promise<Int16Array> {
  return capPauses(await renderClip(text, voice), MAX_PAUSE_MS[style]);
}

async function renderClip(text: string, voice: string): Promise<Int16Array> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash('sha1').update(`${MODEL}|${voice}|${STYLE}|${text}`).digest('hex').slice(0, 16);
  const path = join(CACHE_DIR, `${key}.pcm`);
  if (existsSync(path)) {
    const buf = readFileSync(path);
    return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.audio.speech.create({
    model: MODEL,
    voice: voice as 'alloy',
    input: text,
    instructions: STYLE,
    response_format: 'pcm',
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const pcm24 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)));
  const pcm8 = trimSilence(downsample24kTo8k(pcm24));
  writeFileSync(path, Buffer.from(pcm8.buffer, pcm8.byteOffset, pcm8.byteLength));
  return pcm8;
}
