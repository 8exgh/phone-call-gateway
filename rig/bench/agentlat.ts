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
 * Model latency with the gateway's REAL instructions and tool list: commit a
 * caller line, time the first reply audio. Isolates what the prompt and tools
 * cost, without phone calls.
 *
 *   node --import tsx rig/bench/agentlat.ts <model> <tools: all|control|none> [reasoningEffort] [transcribe: on|off]
 */
const model = process.argv[2] ?? 'gpt-realtime-1.5';
const toolMode = process.argv[3] ?? 'all';
const effort = process.argv[4] && process.argv[4] !== '-' ? process.argv[4] : undefined;
const transcribe = (process.argv[5] ?? 'on') === 'on';
const LINES = ['What time do you close on Saturday?', 'And how much is a new patient exam?', 'Is there parking?', "Hi, I'd like to book a cleaning appointment, please.", 'Sarah Mitchell.', 'Thursday at nine works for me.'];

async function main(): Promise<void> {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
  let committedAt = 0;
  let first = 0;
  let done: (() => void) | null = null;
  const firsts: number[] = [];
  let said = '';
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'error') console.log('ERROR', JSON.stringify(msg.error));
    if ((msg.type === 'response.output_audio.delta' || msg.type === 'response.output_item.added') && !first) {
      if (msg.type === 'response.output_item.added' && msg.item?.type !== 'function_call') return;
      first = Date.now() - committedAt;
      firsts.push(first);
    }
    if (msg.type === 'response.output_audio_transcript.delta') said += msg.delta;
    if (msg.type === 'response.done') {
      const u = msg.response?.usage;
      console.log(`   +${first}ms  in=${u?.input_tokens} cached=${u?.input_token_details?.cached_tokens} out=${u?.output_tokens}  ${said.trim().slice(0, 90)}`);
      said = '';
      done?.();
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const userTools = DEFAULT_TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } }));
  ws.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: buildInstructions({ systemPrompt: `You are ANSWERING an incoming call from +15878175749. ${PERSONA.goal}`, objective: PERSONA.goal } as never),
        ...(effort ? { reasoning: { effort } } : {}),
        audio: {
          input: { format: { type: 'audio/pcmu' }, turn_detection: null, noise_reduction: { type: 'near_field' }, ...(transcribe ? { transcription: { model: 'gpt-transcribe', language: 'en' } } : {}) },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
        tools: toolMode === 'all' ? [...CONTROL_TOOLS, ...userTools] : toolMode === 'control' ? CONTROL_TOOLS : [],
        tool_choice: 'auto',
      },
    }),
  );
  ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PERSONA.openingLine }] } }));
  const pace = async (clip: Int16Array): Promise<void> => {
    const start = Date.now();
    for (let i = 0; i * 160 < clip.length; i++) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(mulawEncode(clip.subarray(i * 160, (i + 1) * 160))).toString('base64') }));
      const wait = start + (i + 1) * 20 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  };
  for (const line of LINES) {
    await pace(new Int16Array(160 * 15));
    await pace(await getClip(line, 'hesitant'));
    await pace(new Int16Array(160 * 10));
    first = 0;
    const finished = new Promise<void>((r) => (done = r));
    committedAt = Date.now();
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    await finished;
  }
  const sorted = [...firsts].sort((a, b) => a - b);
  console.log(`RESULT ${model} tools=${toolMode} effort=${effort ?? 'default'} transcribe=${transcribe}: ${firsts.join(', ')} (median ${sorted[Math.floor(sorted.length / 2)]})`);
  ws.close();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
