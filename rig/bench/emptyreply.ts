import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encode as mulawEncode } from '../../src/audio/mulaw';
import { getClip } from '../lib/clips';
import { PERSONA } from '../scenarios';
import { buildInstructions, CONTROL_TOOLS } from '../../src/realtime/realtimeAgent';
import { DEFAULT_TOOLS } from '../../src/server';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/**
 * After an interruption (text mode), how often does the model answer with
 * nothing? Rebuilds the conversation exactly as the gateway leaves it and asks
 * for the next reply, several times, for different ways of recording the
 * cut-off assistant turn.
 *
 *   node --import tsx rig/bench/emptyreply.ts <variant> [n]
 *   variants: ellipsis | plain | marked | none
 */
const variant = process.argv[2] ?? 'ellipsis';
const n = Number(process.argv[3] ?? 6);
const HEARD = "Sure. We're open Monday to Friday eight";

async function once(): Promise<string> {
  const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  let text = '';
  let calls = '';
  let itemId = '';
  let stage = 0;
  const done = new Promise<void>((resolve) => {
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error') console.log('   ERROR', JSON.stringify(msg.error).slice(0, 200));
      if (msg.type === 'response.output_item.added' && msg.item?.type === 'message' && stage === 1) itemId = msg.item.id;
      if (msg.type === 'response.output_text.delta' && stage === 2) text += msg.delta;
      if (msg.type === 'response.output_item.done' && msg.item?.type === 'function_call' && stage === 2) calls += ` [${msg.item.name}]`;
      if (msg.type === 'response.done') {
        if (stage === 1) {
          stage = 2;
          // The caller interrupts: the gateway replaces the reply with what was heard.
          ws.send(JSON.stringify({ type: 'conversation.item.delete', item_id: itemId }));
          const recorded = variant === 'ellipsis' ? `${HEARD}…` : variant === 'plain' ? HEARD : variant === 'marked' ? `${HEARD} [the caller interrupted here]` : null;
          if (recorded) ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: recorded }] } }));
          void (async () => {
            await send(await getClip('Sorry, sorry, actually, I just need the address.', 'urgent'));
            ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            ws.send(JSON.stringify({ type: 'response.create' }));
          })();
        } else resolve();
      }
    });
  });
  const send = async (clip: Int16Array): Promise<void> => {
    for (let i = 0; i * 160 < clip.length; i += 25) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(mulawEncode(clip.subarray(i * 160, (i + 25) * 160))).toString('base64') }));
    }
  };
  const userTools = DEFAULT_TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } }));
  ws.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['text'],
        instructions: buildInstructions({ systemPrompt: `You are ANSWERING an incoming call from +15878175749. ${PERSONA.goal}`, objective: PERSONA.goal, tts: {} } as never),
        audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: null }, output: { format: { type: 'audio/pcmu' }, voice: 'marin' } },
        tools: [...CONTROL_TOOLS, ...userTools],
        tool_choice: 'auto',
      },
    }),
  );
  ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PERSONA.openingLine }] } }));
  await send(await getClip('Can you tell me your hours, your address, and what the parking is like?'));
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  stage = 1;
  ws.send(JSON.stringify({ type: 'response.create' }));
  await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
  ws.close();
  return `${text.trim() || '(EMPTY)'}${calls}`;
}

async function main(): Promise<void> {
  const results = await Promise.all(Array.from({ length: n }, () => once()));
  let empty = 0;
  for (const r of results) {
    if (r.startsWith('(EMPTY)')) empty++;
    console.log(`   ${r.slice(0, 110)}`);
  }
  console.log(`RESULT ${variant}: ${empty}/${n} empty replies`);
}
main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
