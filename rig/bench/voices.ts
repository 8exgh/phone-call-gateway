import { config as dotenv } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import OpenAI from 'openai';
import { decode as mulawDecode } from '../../src/audio/mulaw';
import { wavMonoBuffer } from '../lib/audio';
import { REALTIME_VOICES } from '../../src/realtime/realtimeAgent';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/**
 * Render a sample of every realtime voice and have an audio model describe
 * each (perceived gender, accent, age, character). OpenAI publishes no such
 * labels; the output seeds the gateway's voice catalog.
 *
 *   node --import tsx rig/bench/voices.ts
 */
const SAMPLE = "Hi, thanks for calling. I can help you book an appointment, answer a question, or take a message. What can I do for you today?";
const outDir = join(__dirname, '..', 'out', 'voices');
mkdirSync(outDir, { recursive: true });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function render(voice: string): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    const chunks: Buffer[] = [];
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'], audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: null }, output: { format: { type: 'audio/pcmu' }, voice } } } }));
      ws.send(JSON.stringify({ type: 'response.create', response: { conversation: 'none', input: [], tool_choice: 'none', instructions: `You are a voice on a phone call. Say exactly this, word for word, in a warm natural tone, and nothing else: "${SAMPLE}"` } }));
    });
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error') reject(new Error(JSON.stringify(msg.error)));
      if (msg.type === 'response.output_audio.delta') chunks.push(Buffer.from(msg.delta, 'base64'));
      if (msg.type === 'response.done') {
        ws.close();
        resolve(mulawDecode(new Uint8Array(Buffer.concat(chunks))));
      }
    });
  });
}

async function describe(pcm: Int16Array): Promise<Record<string, string>> {
  const res = await client.chat.completions.create({
    model: 'gpt-audio-1.5',
    modalities: ['text'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Listen to this synthetic voice sample from a phone line. Describe how the VOICE sounds to a listener. Reply with ONLY JSON: {"gender":"female|male|neutral","accent":"e.g. American, British, Australian","age":"young|middle-aged|older","pitch":"low|medium|high","character":"three or four plain adjectives, e.g. warm, calm, upbeat"}' },
          { type: 'input_audio', input_audio: { data: wavMonoBuffer(pcm).toString('base64'), format: 'wav' } },
        ],
      },
    ],
  } as never);
  const text = (res as { choices: { message: { content: string | null } }[] }).choices[0]?.message.content ?? '';
  const json = /\{[\s\S]*\}/.exec(text);
  return json ? (JSON.parse(json[0]) as Record<string, string>) : { error: text.slice(0, 100) };
}

async function main(): Promise<void> {
  const table: Record<string, unknown> = {};
  await Promise.all(
    REALTIME_VOICES.map(async (voice) => {
      const pcm = await render(voice);
      writeFileSync(join(outDir, `${voice}.wav`), wavMonoBuffer(pcm));
      // Two independent listens: only labels both agree on are trustworthy.
      const [a, b] = await Promise.all([describe(pcm), describe(pcm)]);
      table[voice] = { a, b, seconds: +(pcm.length / 8000).toFixed(1) };
    }),
  );
  for (const voice of REALTIME_VOICES) console.log(voice.padEnd(8), JSON.stringify(table[voice]));
  writeFileSync(join(outDir, 'labels.json'), JSON.stringify(table, null, 2));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
