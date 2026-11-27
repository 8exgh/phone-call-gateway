import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import { decode as mulawDecode, encode as mulawEncode } from '../src/audio/mulaw';
import { fromBase64, toBase64 } from '../src/audio/frames';
import { FRAME, rms } from './lib/audio';
import { createCall, endCall, setVoiceUrl } from './lib/twilio';

dotenv({ path: join(__dirname, '..', '.env'), override: true });
dotenv({ path: join(__dirname, '.state', 'session.env'), override: true });

/**
 * Transport floor: how long sound takes to cross the phone network and back
 * with NO thinking in between. The far end answers a beep with a beep the
 * instant it hears it; the beep-to-beep delay is the part of every measured
 * reply gap that the gateway cannot do anything about.
 *
 *   node --import tsx rig/floor.ts
 */
const AGENT_SID = 'PN3f3017f9a931e21c59da630095fcd977';
const PUBLIC = process.env.RIG_CALLER_PUBLIC!;
const GATEWAY_PUBLIC = process.env.RIG_GATEWAY_PUBLIC!;
const PORT = Number(process.env.RIG_CALLER_PORT ?? 3311);
const BEEPS = 12;

function tone(hz: number, ms: number): Int16Array {
  const out = new Int16Array((ms * 8000) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / 8000));
  return out;
}

async function main(): Promise<void> {
  const app = Fastify();
  await app.register(websocket);
  await app.register(formbody);
  const wss = PUBLIC.replace(/^http/, 'ws');
  app.get('/rig/health', async () => ({ ok: true }));
  app.post('/rig/reflex-voice', async (_req, reply) => {
    reply.type('text/xml');
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wss}/rig/reflex" /></Connect></Response>`;
  });

  const sent: number[] = [];
  const heard: number[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  app.register(async (instance) => {
    // Far end: beep back the moment a beep is heard.
    instance.get('/rig/reflex', { websocket: true }, (socket) => {
      let streamSid = '';
      let quietUntil = 0;
      let k = 0;
      const beep = tone(1000, 200);
      socket.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'start') streamSid = msg.start.streamSid;
        if (msg.event !== 'media') return;
        k++;
        if (k > quietUntil && rms(mulawDecode(fromBase64(msg.media.payload))) > 1500) {
          quietUntil = k + 75;
          for (let i = 0; i < beep.length; i += FRAME) {
            socket.send(JSON.stringify({ event: 'media', streamSid, media: { payload: toBase64(mulawEncode(beep.subarray(i, i + FRAME))) } }));
          }
        }
      });
    });
    // Near end: beep every 3 seconds and listen for the answer.
    instance.get('/rig/probe', { websocket: true }, (socket) => {
      let streamSid = '';
      let k = 0;
      let wasLoud = false;
      const beep = tone(440, 200);
      const silence = new Int16Array(FRAME);
      socket.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'start') streamSid = msg.start.streamSid;
        if (msg.event === 'stop') resolveDone();
        if (msg.event !== 'media') return;
        const loud = rms(mulawDecode(fromBase64(msg.media.payload))) > 1500;
        if (loud && !wasLoud) heard.push(k * 20);
        wasLoud = loud;
        const phase = k % 150; // 3s cycle, beep starts 1s in
        let out: Int16Array = silence;
        if (k >= 100 && phase >= 50 && phase < 60 && sent.length <= BEEPS) {
          if (phase === 50) sent.push(k * 20);
          out = beep.subarray((phase - 50) * FRAME, (phase - 49) * FRAME);
        }
        socket.send(JSON.stringify({ event: 'media', streamSid, media: { payload: toBase64(mulawEncode(out)) } }));
        k++;
        if (sent.length > BEEPS) resolveDone();
      });
      socket.on('close', () => resolveDone());
    });
  });
  await app.listen({ port: PORT, host: '127.0.0.1' });

  await setVoiceUrl(AGENT_SID, `${PUBLIC}/rig/reflex-voice`);
  let callSid = '';
  try {
    callSid = await createCall({
      to: process.env.RIG_AGENT_NUMBER!,
      from: process.env.RIG_CALLER_NUMBER!,
      twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wss}/rig/probe" /></Connect></Response>`,
      timeLimitSec: 60,
    });
    await Promise.race([done, new Promise((r) => setTimeout(r, 70_000))]);
  } finally {
    if (callSid) await endCall(callSid);
    await setVoiceUrl(AGENT_SID, `${GATEWAY_PUBLIC}/twilio/voice`);
  }
  const delays = sent
    .map((s) => heard.find((h) => h > s && h < s + 2500))
    .map((h, i) => (h === undefined ? null : h - sent[i]!))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  console.log(`beeps sent ${sent.length}, answered ${delays.length}`);
  console.log(`round trip ms: ${delays.join(', ')}`);
  console.log(`floor: median ${delays[Math.floor(delays.length / 2)]}ms, min ${delays[0]}ms, max ${delays.at(-1)}ms`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
