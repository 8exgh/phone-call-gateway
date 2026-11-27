import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encode as mulawEncode } from '../../src/audio/mulaw';
import { getClip } from '../lib/clips';
import { PERSONA } from '../scenarios';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/**
 * Off-the-phone benchmark of speech-to-speech models: play a caller line into
 * a realtime session at real-time pace and time how long after the caller's
 * last sound the first reply audio comes back.
 *
 *   node --import tsx rig/bench/realtime.ts <model> <turnDetectionJson> [reasoningEffort]
 */
const model = process.argv[2] ?? 'gpt-realtime-2.1';
const turnDetection = JSON.parse(process.argv[3] ?? '{"type":"semantic_vad","eagerness":"high"}');
const effort = process.argv[4];
const LINES = ['What time do you close on Saturday?', 'And how much is a new patient exam?', 'Is there parking?'];

async function main(): Promise<void> {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  const t0 = Date.now();
  const now = (): number => Date.now() - t0;
  let speechEndAt = 0;
  let firstAudioAt = 0;
  let responseDone: (() => void) | null = null;
  let transcript = '';
  const results: number[] = [];

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    switch (msg.type) {
      case 'error':
        console.log('ERROR', JSON.stringify(msg.error));
        break;
      case 'session.updated':
        break;
      case 'input_audio_buffer.speech_stopped':
        console.log(`   vad speech_stopped +${now() - speechEndAt}ms after last sound`);
        break;
      case 'response.output_audio.delta':
        if (!firstAudioAt && speechEndAt) {
          firstAudioAt = now();
          results.push(firstAudioAt - speechEndAt);
          console.log(`   first reply audio +${firstAudioAt - speechEndAt}ms after last sound`);
        }
        break;
      case 'response.output_audio_transcript.delta':
        transcript += msg.delta;
        break;
      case 'response.done':
        console.log(`   agent: ${transcript.trim()} [${msg.response?.status}]`);
        transcript = '';
        responseDone?.();
        break;
      default:
        break;
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
        output_modalities: ['audio'],
        instructions: `${PERSONA.goal}\nYou are on a live phone call. Reply in one or two short spoken sentences.`,
        ...(effort ? { reasoning: { effort } } : {}),
        audio: {
          input: { format: { type: 'audio/pcmu' }, noise_reduction: { type: 'near_field' }, turn_detection: turnDetection },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
      },
    }),
  );

  const sendFrame = (pcm: Int16Array): void => {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(mulawEncode(pcm)).toString('base64') }));
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

  await pace(25, () => sendFrame(silence));
  for (const line of LINES) {
    const clip = await getClip(line, 'hesitant');
    const frames = Math.floor(clip.length / 160);
    console.log(`caller: ${line}`);
    firstAudioAt = 0;
    speechEndAt = 0;
    await pace(frames, (i) => sendFrame(clip.subarray(i * 160, (i + 1) * 160)));
    speechEndAt = now();
    const done = new Promise<void>((r) => (responseDone = r));
    // Keep the line open with silence, as a phone would, until the reply is finished.
    let finished = false;
    void done.then(() => (finished = true));
    for (let i = 0; i < 500 && !finished; i++) await pace(1, () => sendFrame(silence));
    await pace(40, () => sendFrame(silence));
  }
  results.sort((a, b) => a - b);
  console.log(`RESULT ${model} ${JSON.stringify(turnDetection)} effort=${effort ?? 'default'}: ${results.join(', ')} ms (median ${results[Math.floor(results.length / 2)]})`);
  ws.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
