import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encode as mulawEncode } from '../../src/audio/mulaw';
import { getClip } from '../lib/clips';
import { PERSONA } from '../scenarios';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/**
 * Can the realtime model itself tell a finished thought from a mid-sentence
 * pause? Each clip is committed in a fresh session; the model either replies
 * or calls keep_listening. Reports the decision and how long it took.
 *
 *   node --import tsx rig/bench/hold.ts <model> <audio|text>
 */
const model = process.argv[2] ?? 'gpt-realtime-1.5';
const modality = process.argv[3] ?? 'audio';
const CASES: [string, 'hold' | 'reply'][] = [
  ['Hi, um, I wanted to ask about', 'hold'],
  ['Okay. And if I wanted to come in this week, um,', 'hold'],
  ['Let me think.', 'hold'],
  ['Wednesday at two, I guess. My name is', 'hold'],
  ['What time do you close on Saturday?', 'reply'],
  ['Is there parking?', 'reply'],
  ['Sarah Mitchell.', 'reply'],
  ["It's five eight seven, five five five, zero one four two.", 'reply'],
  ['Thursday at nine works for me.', 'reply'],
  ['your cancellation policy.', 'reply'],
  ["Yes, that's right. Thanks so much, bye.", 'reply'],
  ['Great, thanks. Bye.', 'reply'],
];

const INSTRUCTIONS = `${PERSONA.goal}
You are on a live phone call. Reply in one or two short spoken sentences.
The caller's audio reaches you the instant they pause. If their last words are clearly an unfinished sentence or thought (they trailed off mid-sentence, ended on a filler like "um", or said they need a moment to think), do not speak: call keep_listening so they can finish. If what they said is a complete question, answer or statement, reply normally and never call keep_listening.`;

async function one(text: string): Promise<{ decision: string; ms: number; said: string }> {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  let committedAt = 0;
  let decision = '';
  let ms = 0;
  let said = '';
  const done = new Promise<void>((resolve) => {
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error') console.log('ERROR', JSON.stringify(msg.error));
      if (!decision) {
        if (msg.type === 'response.output_audio.delta' || msg.type === 'response.output_text.delta') {
          decision = 'reply';
          ms = Date.now() - committedAt;
        } else if (msg.type === 'response.output_item.added' && msg.item?.type === 'function_call') {
          decision = 'hold';
          ms = Date.now() - committedAt;
        }
      }
      if (msg.type === 'response.output_audio_transcript.delta' || msg.type === 'response.output_text.delta') said += msg.delta;
      if (msg.type === 'response.done') resolve();
    });
  });
  ws.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: [modality],
        instructions: INSTRUCTIONS,
        ...(process.env.EFFORT ? { reasoning: { effort: process.env.EFFORT } } : {}),
        audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: null }, output: { format: { type: 'audio/pcmu' }, voice: 'marin' } },
        tools: [
          {
            type: 'function',
            name: 'keep_listening',
            description: 'Stay silent and keep listening because the caller has not finished their sentence or thought.',
            parameters: { type: 'object', properties: {} },
          },
        ],
        tool_choice: 'auto',
      },
    }),
  );
  // The receptionist has already greeted the caller.
  ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PERSONA.openingLine }] } }));
  const clip = await getClip(text, 'hesitant');
  const padded = new Int16Array(clip.length + 160 * 8);
  padded.set(clip, 0);
  for (let i = 0; i * 160 < padded.length; i += 5) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(mulawEncode(padded.subarray(i * 160, (i + 5) * 160))).toString('base64') }));
  }
  committedAt = Date.now();
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  ws.send(JSON.stringify({ type: 'response.create' }));
  await Promise.race([done, new Promise((r) => setTimeout(r, 15000))]);
  ws.close();
  return { decision, ms, said: said.trim() };
}

async function main(): Promise<void> {
  let right = 0;
  for (const [text, want] of CASES) {
    const r = await one(text);
    if (r.decision === want) right++;
    console.log(`${r.decision === want ? 'ok  ' : 'MISS'} want=${want.padEnd(5)} got=${r.decision.padEnd(5)} +${r.ms}ms  "${text}"${r.said ? `  -> ${r.said.slice(0, 80)}` : ''}`);
  }
  console.log(`RESULT ${model} ${modality}: ${right}/${CASES.length} correct`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
