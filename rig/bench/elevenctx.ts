import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import WebSocket from 'ws';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/** How does an ElevenLabs multi-context socket react to cancelled, double-closed and many contexts? */
async function main(): Promise<void> {
  const ws = new WebSocket('wss://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/multi-stream-input?model_id=eleven_flash_v2_5&output_format=ulaw_8000&inactivity_timeout=180', {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
  });
  const got = new Map<string, number>();
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    const id = msg.contextId ?? msg.context_id ?? '?';
    if (msg.audio) got.set(id, (got.get(id) ?? 0) + Buffer.from(msg.audio, 'base64').length);
    else console.log('   msg', JSON.stringify(msg).slice(0, 220));
  });
  ws.on('close', (code, reason) => console.log(`CLOSED ${code} ${reason.toString().slice(0, 200)}`));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const init = (id: string): void => ws.send(JSON.stringify({ text: ' ', context_id: id, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 } }));
  const say = (id: string, text: string): void => ws.send(JSON.stringify({ text: `${text} `, context_id: id, flush: true }));
  const close = (id: string): void => ws.send(JSON.stringify({ context_id: id, close_context: true }));
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  console.log('1. normal'); init('a'); say('a', 'Hello there, this is the first one.'); close('a'); await wait(1200);
  console.log('2. closed twice'); init('b'); say('b', 'This one is closed twice.'); close('b'); close('b'); await wait(1200);
  console.log('3. opened, text, cancelled mid-way, then closed again'); init('c'); say('c', 'We are open Monday to Friday from eight until six, and on Saturday mornings from nine until one.'); await wait(150); close('c'); await wait(100); close('c'); await wait(1000);
  console.log('4. opened with no text, closed'); init('d'); close('d'); await wait(600);
  console.log('5. six more in a burst'); for (const id of ['e', 'f', 'g', 'h', 'i', 'j']) { init(id); say(id, `Burst ${id}.`); close(id); } await wait(2500);
  console.log('6. after all that'); init('z'); say('z', 'Is this still working?'); close('z'); await wait(1500);
  console.log('audio bytes per context:', JSON.stringify([...got]));
  ws.close();
}
main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
