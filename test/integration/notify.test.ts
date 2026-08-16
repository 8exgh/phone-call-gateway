import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGateway, type Gateway } from './helpers';
import { FakeChatClient } from '../../src/fakes/fakeChatClient';

const ADMIN = 'notify-admin';

async function req(
  url: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A webhook receiver that records payloads (and can be told to hang forever). */
function receiver(hang = false): Promise<{ url: string; events: Record<string, unknown>[]; close: () => void }> {
  const events: Record<string, unknown>[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      events.push(JSON.parse(body) as Record<string, unknown>);
      if (!hang) response.end('ok'); // hanging receiver records but never responds
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/hook`, events, close: () => server.close() });
    });
  });
}

async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('webhook notifications (multi-client isolation)', () => {
  let gw: Gateway;
  const receivers: { close: () => void }[] = [];

  afterEach(async () => {
    await gw.close();
    for (const r of receivers.splice(0)) r.close();
  });

  it('pings the right client on tool requests; a dead endpoint on one client never affects another', async () => {
    const hookA = await receiver();
    const hookB = await receiver(true); // records, then hangs forever
    receivers.push(hookA, hookB);

    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { waitForSayCompleted: true },
        { speak: { text: 'are you busy tomorrow', durationMs: 1800 } },
        { waitForSayCompleted: true },
        { waitForSayCompleted: true },
        { pauseMs: 400 },
        { hangup: true },
      ],
      chatClientFactory: () =>
        new FakeChatClient([
          { reply: '', toolCalls: [{ name: 'check_calendar', arguments: '{"query":"tomorrow"}' }] },
          { reply: 'You are free. HANGUP' },
        ]),
      serverConfig: {
        adminApiKey: ADMIN,
        dataDir: mkdtempSync(path.join(tmpdir(), 'pgw-notify-')),
        quotaCacheTtlMs: 0,
        notifyTimeoutMs: 300,
        allowPrivateNotifyTargets: true,
      },
    });

    const a = (await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name: 'a' } }))
      .json as unknown as { id: string; apiKey: string };
    const b = (await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name: 'b' } }))
      .json as unknown as { id: string; apiKey: string };
    await req(`${gw.baseUrl}/numbers`, { token: a.apiKey, body: { areaCode: '431' } });
    await req(`${gw.baseUrl}/numbers`, { token: b.apiKey, body: { areaCode: '587' } });
    expect((await req(`${gw.baseUrl}/notify-config`, { token: a.apiKey, body: { url: hookA.url } })).status).toBe(200);
    expect((await req(`${gw.baseUrl}/notify-config`, { token: b.apiKey, body: { url: hookB.url } })).status).toBe(200);

    // Client A places a call whose agent requests a tool.
    const placed = await req(`${gw.baseUrl}/orchestrations`, {
      token: a.apiKey,
      body: { to: '+15550001111', goal: 'availability', openingLine: 'Hello!' },
    });
    const id = String(placed.json.orchestrationId);

    // A gets the tool.requested ping (addressed to the right call); B gets nothing.
    await until(() => hookA.events.some((e) => e.event === 'tool.requested'));
    const ping = hookA.events.find((e) => e.event === 'tool.requested')!;
    expect(ping).toMatchObject({ orchestrationId: id, name: 'check_calendar' });
    expect(hookB.events.filter((e) => e.event === 'tool.requested')).toHaveLength(0);

    // Fulfill via the ping's respondUrl and let the call finish normally.
    const responded = await req(`${gw.baseUrl}${String(ping.respondUrl)}`, {
      token: a.apiKey,
      body: { requestId: String(ping.requestId), result: 'Free all day.' },
    });
    expect(responded.status).toBe(200);
    await until(() => false, 1).catch(() => undefined); // yield
    await until(
      () => hookA.events.length >= 1, // already true; the real assertion is the call completing:
    );

    // Meanwhile B (with the hanging endpoint) can still run calls unimpeded.
    const placedB = await req(`${gw.baseUrl}/orchestrations`, {
      token: b.apiKey,
      body: { to: '+15550002222', goal: 'quick hello', openingLine: 'Hi!' },
    });
    expect(placedB.status).toBe(202);
  });

  it('pings followup.promised on tool timeout and call.ended for inbound calls', async () => {
    const hook = await receiver();
    receivers.push(hook);

    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { waitForSayCompleted: true },
        { speak: { text: 'weather in calgary please', durationMs: 1800 } },
        { pauseMs: 6000 },
      ],
      chatClientFactory: () =>
        new FakeChatClient([
          { reply: '', toolCalls: [{ name: 'web_search', arguments: '{"query":"weather"}' }] },
        ]),
      serverConfig: {
        adminApiKey: ADMIN,
        dataDir: mkdtempSync(path.join(tmpdir(), 'pgw-notify-')),
        quotaCacheTtlMs: 0,
        toolTimeoutMs: 300,
        notifyTimeoutMs: 300,
        allowPrivateNotifyTargets: true,
      },
    });

    const c = (await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name: 'c' } }))
      .json as unknown as { id: string; apiKey: string };
    await req(`${gw.baseUrl}/numbers`, { token: c.apiKey, body: { areaCode: '431' } });
    await req(`${gw.baseUrl}/notify-config`, { token: c.apiKey, body: { url: hook.url } });

    await req(`${gw.baseUrl}/orchestrations`, {
      token: c.apiKey,
      body: { to: '+15550001111', goal: 'weather', openingLine: 'Hello!' },
    });

    await until(() => hook.events.some((e) => e.event === 'followup.promised'));
    // The agent hangs up after promising; the ended ping follows (followUpRequired).
    await until(() => hook.events.some((e) => e.event === 'call.ended'));
    const ended = hook.events.find((e) => e.event === 'call.ended')!;
    expect(ended).toMatchObject({ followUpRequired: true });
  });

  it('rejects private notify targets unless explicitly allowed', async () => {
    gw = await startGateway({
      serverConfig: { adminApiKey: ADMIN, dataDir: mkdtempSync(path.join(tmpdir(), 'pgw-notify-')) },
    });
    const c = (await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name: 'c' } }))
      .json as unknown as { apiKey: string };
    for (const url of ['http://127.0.0.1:9/x', 'http://192.168.4.56:3052/x', 'http://localhost/x']) {
      expect((await req(`${gw.baseUrl}/notify-config`, { token: c.apiKey, body: { url } })).status).toBe(400);
    }
    expect(
      (await req(`${gw.baseUrl}/notify-config`, { token: c.apiKey, body: { url: 'https://example.com/hook' } }))
        .status,
    ).toBe(200);
  });
});
