import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { decode as mulawDecode } from '../../src/audio/mulaw';
import { rms, wavMonoBuffer } from '../lib/audio';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/**
 * ElevenLabs streaming speech over one warm multi-context WebSocket: time from
 * sending a sentence to the first audible audio, for several sentences in a row.
 *
 *   node --import tsx rig/bench/eleven.ts [voiceId] [host]
 */
const voice = process.argv[2] ?? 'EXAVITQu4vr4xnSDxMaL';
const host = process.argv[3] ?? 'api.elevenlabs.io';
const LINES = ['We close at one p.m. on Saturday.', 'A new patient exam and cleaning is one hundred eighty nine dollars.', 'Yes, there is free parking behind the building.', 'Sure. Can I get your full name?'];

async function main(): Promise<void> {
  const t0 = Date.now();
  const ws = new WebSocket(`wss://${host}/v1/text-to-speech/${voice}/multi-stream-input?model_id=eleven_flash_v2_5&output_format=ulaw_8000&inactivity_timeout=180`, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
  });
  const audio = new Map<string, Buffer[]>();
  const firstAt = new Map<string, number>();
  const finals = new Map<string, () => void>();
  const sentAt = new Map<string, number>();
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    const ctx = msg.contextId ?? msg.context_id;
    if (msg.audio) {
      const bytes = Buffer.from(msg.audio, 'base64');
      if (!audio.has(ctx)) audio.set(ctx, []);
      audio.get(ctx)!.push(bytes);
      if (!firstAt.has(ctx) && rms(mulawDecode(new Uint8Array(bytes))) > 150) firstAt.set(ctx, Date.now() - sentAt.get(ctx)!);
    }
    if (msg.isFinal || msg.is_final) finals.get(ctx)?.();
    if (!msg.audio && !msg.isFinal) console.log('   msg', JSON.stringify(msg).slice(0, 200));
  });
  ws.on('close', (code, reason) => console.log(`closed ${code} ${reason.toString().slice(0, 200)}`));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  console.log(`connected in ${Date.now() - t0}ms`);
  const results: number[] = [];
  for (let i = 0; i < LINES.length; i++) {
    const ctx = `r${i}`;
    const done = new Promise<void>((r) => finals.set(ctx, r));
    sentAt.set(ctx, Date.now());
    ws.send(JSON.stringify({ text: ' ', context_id: ctx, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 } }));
    ws.send(JSON.stringify({ text: `${LINES[i]} `, context_id: ctx, flush: true }));
    ws.send(JSON.stringify({ context_id: ctx, close_context: true }));
    await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
    const total = Buffer.concat(audio.get(ctx) ?? []);
    console.log(`   "${LINES[i]}" first audio +${firstAt.get(ctx)}ms, ${(total.length / 8000).toFixed(1)}s of audio in ${audio.get(ctx)?.length} chunks, all in ${Date.now() - sentAt.get(ctx)!}ms`);
    if (firstAt.has(ctx)) results.push(firstAt.get(ctx)!);
    if (i === 0) writeFileSync(join(__dirname, '..', 'out', `eleven-${voice}.wav`), wavMonoBuffer(mulawDecode(new Uint8Array(total))));
    await new Promise((r) => setTimeout(r, 700));
  }
  results.sort((a, b) => a - b);
  console.log(`RESULT ${host} ${voice}: first audio ${results.join(', ')} ms (median ${results[Math.floor(results.length / 2)]})`);
  ws.send(JSON.stringify({ close_socket: true }));
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
