import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decode as mulawDecode, encode as mulawEncode } from '../../src/audio/mulaw';
import { getClip } from '../lib/clips';
import { rms } from '../lib/audio';
import { PERSONA } from '../scenarios';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/**
 * Off-the-phone benchmark of the full-duplex Live voice API: play caller lines
 * in at real-time pace over one always-open audio stream and time the first
 * audible reply after each.
 *
 *   node --import tsx rig/bench/live.ts [model]
 */
const model = process.argv[2] ?? 'gpt-live-1.1';
const LINES = (process.argv[3] ?? 'What time do you close on Saturday?|And how much is a new patient exam?|Is there parking?').split('|');

async function main(): Promise<void> {
  const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  const t0 = Date.now();
  const now = (): number => Date.now() - t0;
  let started: (() => void) | null = null;
  let speechEndAt = 0;
  let firstAudioAt = 0;
  let lastLoudAt = 0;
  let outBytes = 0;
  const results: number[] = [];
  const seen = new Map<string, number>();

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    seen.set(msg.type, (seen.get(msg.type) ?? 0) + 1);
    if (msg.type === 'error') console.log('ERROR', JSON.stringify(msg).slice(0, 600));
    else if (msg.type === 'session.started') {
      console.log('session.started', JSON.stringify(msg.session).slice(0, 700));
      started?.();
    } else if (msg.type === 'session.output_audio.delta') {
      const bytes = Buffer.from(msg.delta, 'base64');
      outBytes += bytes.length;
      const level = rms(mulawDecode(new Uint8Array(bytes)));
      if (level > 180) {
        lastLoudAt = now();
        if (!firstAudioAt && speechEndAt) {
          firstAudioAt = now();
          results.push(firstAudioAt - speechEndAt);
          console.log(`   first audible reply +${firstAudioAt - speechEndAt}ms after last sound (chunk ${bytes.length} bytes)`);
        }
      }
    } else if (msg.type === 'session.output_transcript.delta') {
      process.stdout.write(`   [agent +${now()}ms] ${msg.delta}\n`);
    } else if (msg.type === 'session.input_transcript.delta') {
      process.stdout.write(`   [heard +${now()}ms] ${msg.delta}\n`);
    } else if (!/output_audio|transcript/.test(msg.type)) {
      console.log(`   event ${msg.type} ${JSON.stringify(msg).slice(0, 300)}`);
    }
  });
  ws.on('close', (code, reason) => console.log(`socket closed ${code} ${reason.toString()}`));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const ready = new Promise<void>((r) => (started = r));
  ws.send(
    JSON.stringify({
      type: 'session.start',
      event_id: 'event_start',
      session: {
        model,
        instructions: `${PERSONA.goal}\nYou are on a live phone call. Keep replies to one or two short spoken sentences.`,
        audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
        delegation: { type: 'client' },
      },
    }),
  );
  await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no session.started in 10s')), 10_000))]);

  const sendFrame = (pcm: Int16Array): void => {
    ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: Buffer.from(mulawEncode(pcm)).toString('base64') }));
  };
  const silence = new Int16Array(160);
  const pace = async (frames: number, fn: (i: number) => void): Promise<void> => {
    const start = Date.now();
    for (let i = 0; i < frames; i++) {
      fn(i);
      const wait = start + (i + 1) * 20 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  };

  await pace(50, () => sendFrame(silence));
  for (const line of LINES) {
    const clip = await getClip(line, 'hesitant');
    console.log(`caller: ${line}`);
    firstAudioAt = 0;
    speechEndAt = 0;
    await pace(Math.floor(clip.length / 160), (i) => sendFrame(clip.subarray(i * 160, (i + 1) * 160)));
    speechEndAt = now();
    // Hold the line open with silence until the agent has spoken and gone quiet for 1.2s.
    for (let i = 0; i < 600; i++) {
      await pace(1, () => sendFrame(silence));
      if (firstAudioAt && now() - lastLoudAt > 1200) break;
    }
  }
  results.sort((a, b) => a - b);
  console.log(`RESULT ${model}: ${results.join(', ')} ms (median ${results[Math.floor(results.length / 2)]}); out audio ${(outBytes / 8000).toFixed(1)}s; events ${JSON.stringify([...seen])}`);
  ws.send(JSON.stringify({ type: 'session.close' }));
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
