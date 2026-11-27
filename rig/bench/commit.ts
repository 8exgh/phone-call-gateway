import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encode as mulawEncode } from '../../src/audio/mulaw';
import { getClip } from '../lib/clips';
import { PERSONA } from '../scenarios';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/**
 * How fast does a realtime model answer when WE decide the caller is done?
 * Turn detection is off; the clip is committed the moment it ends and the
 * time to the first reply (audio or text) is measured from that commit.
 *
 *   node --import tsx rig/bench/commit.ts <model> <audio|text> [reasoningEffort]
 */
const model = process.argv[2] ?? 'gpt-realtime-1.5';
const modality = process.argv[3] ?? 'audio';
const effort = process.argv[4];
const LINES = ['What time do you close on Saturday?', 'And how much is a new patient exam?', 'Is there parking?', "Hi, I'd like to book a cleaning appointment, please."];

async function main(): Promise<void> {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  let committedAt = 0;
  let first = 0;
  let sentenceAt = 0;
  let text = '';
  let done: (() => void) | null = null;
  const firsts: number[] = [];
  const sentences: number[] = [];
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'error') console.log('ERROR', JSON.stringify(msg.error));
    if (msg.type === 'response.output_audio.delta' || msg.type === 'response.output_text.delta') {
      if (!first) {
        first = Date.now() - committedAt;
        firsts.push(first);
      }
    }
    if (msg.type === 'response.output_text.delta' || msg.type === 'response.output_audio_transcript.delta') {
      text += msg.delta;
      if (!sentenceAt && /[.!?,]\s*$/.test(text) && text.trim().length > 12) {
        sentenceAt = Date.now() - committedAt;
        sentences.push(sentenceAt);
      }
    }
    if (msg.type === 'response.done') {
      console.log(`   first ${modality} +${first}ms, first phrase text +${sentenceAt}ms: ${text.trim()} [${msg.response?.status}]`);
      done?.();
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
        type: 'realtime',
        output_modalities: [modality],
        instructions: `${PERSONA.goal}\nYou are on a live phone call. Reply in one or two short spoken sentences.`,
        ...(effort ? { reasoning: { effort } } : {}),
        audio: {
          input: { format: { type: 'audio/pcmu' }, turn_detection: null },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
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
  for (const line of LINES) {
    console.log(`caller: ${line}`);
    await pace(new Int16Array(160 * 15));
    await pace(await getClip(line, 'hesitant'));
    first = 0;
    sentenceAt = 0;
    text = '';
    const finished = new Promise<void>((r) => (done = r));
    committedAt = Date.now();
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    await finished;
  }
  const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  console.log(`RESULT ${model} ${modality} effort=${effort ?? 'default'}: first ${firsts.join(', ')} (median ${med(firsts)}); first phrase ${sentences.join(', ')} (median ${med(sentences)})`);
  ws.close();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
