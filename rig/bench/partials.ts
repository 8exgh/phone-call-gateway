import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encode as mulawEncode } from '../../src/audio/mulaw';
import { getClip, type ClipStyle } from '../lib/clips';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/**
 * How soon does a streaming transcriber give the FIRST word of something a
 * caller says? (To tell "mm-hmm" from "wait, sorry" while the agent is talking.)
 *
 *   node --import tsx rig/bench/partials.ts [model] [delay]
 */
const model = process.argv[2] ?? 'gpt-live-transcribe';
const delay = process.argv[3] ?? 'minimal';
const CASES: [string, ClipStyle][] = [
  ['Mm-hmm.', 'natural'],
  ['Uh-huh.', 'natural'],
  ['Sorry, sorry, actually, I just need the address.', 'urgent'],
  ['Wait, hang on, just the exam price please.', 'urgent'],
  ['Is there parking?', 'natural'],
  ['Okay, thanks. Bye.', 'natural'],
];

async function main(): Promise<void> {
  const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
  let onsetAt = 0;
  let firstAt = 0;
  let text = '';
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'error') console.log('ERROR', JSON.stringify(msg.error).slice(0, 300));
    if (msg.type === 'conversation.item.input_audio_transcription.delta' && msg.delta) {
      if (!firstAt && onsetAt) firstAt = Date.now() - onsetAt;
      text += msg.delta;
      console.log(`      +${Date.now() - onsetAt}ms "${msg.delta}"`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: { input: { format: { type: 'audio/pcmu' }, transcription: { model, language: 'en', ...(delay !== '-' ? { delay } : {}) }, turn_detection: null } },
      },
    }),
  );
  const pace = async (clip: Int16Array): Promise<void> => {
    const start = Date.now();
    for (let i = 0; i * 160 < clip.length; i++) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(mulawEncode(clip.subarray(i * 160, (i + 1) * 160))).toString('base64') }));
      const wait = start + (i + 1) * 20 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  };
  const firsts: number[] = [];
  for (const [line, style] of CASES) {
    await pace(new Int16Array(160 * 40));
    const clip = await getClip(line, style);
    console.log(`"${line}" (${Math.round(clip.length / 8)}ms)`);
    onsetAt = Date.now();
    firstAt = 0;
    text = '';
    await pace(clip);
    await pace(new Int16Array(160 * 60));
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await new Promise((r) => setTimeout(r, 1200));
    console.log(`   first word +${firstAt || 'never'}ms  heard: "${text.trim()}"`);
    if (firstAt) firsts.push(firstAt);
  }
  console.log(`RESULT ${model} delay=${delay}: first word after ${firsts.join(', ')} ms`);
  ws.close();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
