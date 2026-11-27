import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGateway, type Gateway } from './helpers';
import type { RealtimeSocket } from '../../src/realtime/realtimeSocket';
import { encode as mulawEncode } from '../../src/audio/mulaw';

const ADMIN = 'admin-secret';

async function call(
  gw: Gateway,
  method: string,
  route: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers; bytes: Buffer }> {
  const res = await fetch(`${gw.baseUrl}${route}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(bytes.toString()) as Record<string, unknown>;
  } catch {
    /* not JSON (audio) */
  }
  return { status: res.status, json, headers: res.headers, bytes };
}

/** A model socket that speaks half a second of tone for any request, and counts how often it is asked. */
function speakingSocketFactory(counter: { opened: number }): (model: string) => RealtimeSocket {
  return () => {
    counter.opened++;
    let onEvent: ((event: Record<string, unknown>) => void) | null = null;
    let onOpen: (() => void) | null = null;
    setTimeout(() => onOpen?.(), 0);
    return {
      send(event) {
        if (event.type !== 'response.create') return;
        const pcm = new Int16Array(4000);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 8000));
        setTimeout(() => {
          onEvent?.({ type: 'response.output_audio.delta', delta: Buffer.from(mulawEncode(pcm)).toString('base64') });
          onEvent?.({ type: 'response.done', response: { status: 'completed' } });
        }, 0);
      },
      close() {},
      onOpen(handler) {
        onOpen = handler;
      },
      onEvent(handler) {
        onEvent = handler;
      },
      onClosed() {},
    };
  };
}

describe('voices', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  it('lists voices with gender and accent, and filters them', async () => {
    gw = await startGateway();
    const all = await call(gw, 'GET', '/voices');
    expect(all.status).toBe(200);
    const voices = all.json.voices as { id: string; gender: string; accent: string; previewUrl: string }[];
    expect(voices.length).toBeGreaterThanOrEqual(10);
    expect(all.json.count).toBe(voices.length);
    expect(all.json.filters).toEqual(
      expect.objectContaining({ genders: ['female', 'male', 'neutral'], accents: expect.arrayContaining(['American', 'British']) }),
    );
    expect(voices[0]).toEqual(expect.objectContaining({ id: expect.any(String), gender: expect.any(String), accent: expect.any(String) }));

    const men = await call(gw, 'GET', '/voices?gender=male');
    const menVoices = men.json.voices as { gender: string }[];
    expect(menVoices.length).toBeGreaterThan(0);
    expect(menVoices.every((v) => v.gender === 'male')).toBe(true);

    const british = await call(gw, 'GET', '/voices?accent=british');
    expect((british.json.voices as { id: string }[]).map((v) => v.id)).toEqual(['ballad']);
  });

  it('sets, shows and clears the default voice, rejecting names it does not know', async () => {
    gw = await startGateway();
    const bad = await call(gw, 'POST', '/voice-config', { body: { voice: 'darth' } });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toContain('GET /voices');

    const set = await call(gw, 'POST', '/voice-config', { body: { voice: 'Cedar' } });
    expect(set.status).toBe(200);
    expect((set.json.voice as { id: string }).id).toBe('cedar');
    const shown = await call(gw, 'GET', '/voice-config');
    expect(shown.json).toEqual(expect.objectContaining({ source: 'configured', voice: expect.objectContaining({ id: 'cedar', gender: 'male' }) }));
    expect((await call(gw, 'GET', '/voices')).json.default).toBe('cedar');

    const cleared = await call(gw, 'DELETE', '/voice-config');
    expect(cleared.json.source).toBe('server default');
  });

  it("keeps each client's default voice separate and across restarts", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pgw-voices-'));
    gw = await startGateway({ serverConfig: { adminApiKey: ADMIN, dataDir } });
    const a = (await call(gw, 'POST', '/clients', { token: ADMIN, body: { name: 'alpha' } })).json as { apiKey: string };
    const b = (await call(gw, 'POST', '/clients', { token: ADMIN, body: { name: 'beta' } })).json as { apiKey: string };
    expect((await call(gw, 'GET', '/voices')).status).toBe(401);

    await call(gw, 'POST', '/voice-config', { token: a.apiKey, body: { voice: 'coral' } });
    expect(((await call(gw, 'GET', '/voice-config', { token: a.apiKey })).json.voice as { id: string }).id).toBe('coral');
    expect((await call(gw, 'GET', '/voice-config', { token: b.apiKey })).json.source).toBe('server default');

    await gw.close();
    gw = await startGateway({ serverConfig: { adminApiKey: ADMIN, dataDir } });
    expect(((await call(gw, 'GET', '/voice-config', { token: a.apiKey })).json.voice as { id: string }).id).toBe('coral');
  });

  it('serves a spoken preview of a voice as a WAV, rendering it only once', async () => {
    const counter = { opened: 0 };
    gw = await startGateway({ realtime: { socketFactory: speakingSocketFactory(counter), model: 'test', voice: 'marin' } });
    const first = await call(gw, 'GET', '/voices/cedar/preview');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('audio/wav');
    expect(first.bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(first.bytes.length).toBe(44 + 4000 * 2);
    const second = await call(gw, 'GET', '/voices/cedar/preview');
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(counter.opened).toBe(1);
    expect((await call(gw, 'GET', '/voices/nobody/preview')).status).toBe(404);
  });

  it('has no previews without the realtime engine', async () => {
    gw = await startGateway();
    expect((await call(gw, 'GET', '/voices/cedar/preview')).status).toBe(501);
  });

  it('places a call in the default voice, with a warning, when asked for a voice it does not know', async () => {
    const counter = { opened: 0 };
    gw = await startGateway({
      script: [{ pauseMs: 200 }, { hangup: true }],
      realtime: { socketFactory: speakingSocketFactory(counter), model: 'test', voice: 'marin' },
    });
    await call(gw, 'POST', '/numbers', { body: { areaCode: '415' } });
    const started = await call(gw, 'POST', '/orchestrations', { body: { to: '+15550001111', goal: 'Say hello.', voice: 'darth' } });
    expect(started.status).toBe(202);
    expect(started.json.voice).toBe('marin');
    expect(started.json.warnings).toEqual([expect.stringContaining('unknown voice "darth"')]);

    const chosen = await call(gw, 'POST', '/orchestrations', { body: { to: '+15550001111', goal: 'Say hello.', voice: 'sage' } });
    expect(chosen.json.voice).toBe('sage');
    expect(chosen.json.warnings).toBeUndefined();
  });
});
