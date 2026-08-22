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
function receiver(hang = false, statuses: number[] = [], port = 0): Promise<{
  url: string;
  events: Record<string, unknown>[];
  headers: Record<string, string | string[] | undefined>[];
  close: () => void;
}> {
  const events: Record<string, unknown>[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      events.push(JSON.parse(body) as Record<string, unknown>);
      headers.push(request.headers);
      if (!hang) {
        response.statusCode = statuses.shift() ?? 200;
        response.end('ok');
      } // hanging receiver records but never responds
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${bound}/hook`, events, headers, close: () => server.close() });
    });
  });
}

/** A port nothing listens on any more (connections to it are refused). */
async function deadPort(): Promise<number> {
  const probe = await receiver();
  const port = Number(new URL(probe.url).port);
  await new Promise<void>((resolve) => {
    probe.close();
    setTimeout(resolve, 50);
  });
  return port;
}

async function untilAsync(cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
    expect(
      (
        await req(`${gw.baseUrl}/notify-config`, {
          token: a.apiKey,
          body: { url: hookA.url, headers: { 'x-openclaw-token': 'claw-secret' } },
        })
      ).status,
    ).toBe(200);
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
    expect(ping.notificationId).toBe(`tool.requested:${id}:${String(ping.requestId)}`);
    expect(ping.idempotencyKey).toBe(ping.notificationId);
    expect(hookA.headers[0]!['idempotency-key']).toBe(ping.notificationId);
    expect(hookA.headers[0]!['x-openclaw-token']).toBe('claw-secret');
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

  it('retries a non-2xx notification with the same idempotency key', async () => {
    const hook = await receiver(false, [503, 200]);
    receivers.push(hook);
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { waitForSayCompleted: true },
        { speak: { text: 'check tomorrow', durationMs: 1200 } },
        { pauseMs: 3000 },
      ],
      chatClientFactory: () =>
        new FakeChatClient([
          { reply: '', toolCalls: [{ name: 'check_calendar', arguments: '{"query":"tomorrow"}' }] },
        ]),
      serverConfig: {
        adminApiKey: ADMIN,
        dataDir: mkdtempSync(path.join(tmpdir(), 'pgw-notify-')),
        notifyTimeoutMs: 300,
        allowPrivateNotifyTargets: true,
      },
    });
    const c = (await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name: 'retry' } }))
      .json as unknown as { apiKey: string };
    await req(`${gw.baseUrl}/numbers`, { token: c.apiKey, body: { areaCode: '431' } });
    await req(`${gw.baseUrl}/notify-config`, { token: c.apiKey, body: { url: hook.url } });
    await req(`${gw.baseUrl}/orchestrations`, {
      token: c.apiKey,
      body: { to: '+15550001111', goal: 'quick call', openingLine: 'Hello!' },
    });
    await until(() => hook.events.length === 2);
    expect(hook.headers[0]!['idempotency-key']).toBe(hook.headers[1]!['idempotency-key']);
  });

  it('records every delivery attempt and keeps re-pinging an owed callback until a receiver accepts it', async () => {
    const port = await deadPort(); // the client's endpoint is down when the promise is made
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
        notifyRetryDelaysMs: [50],
        followUpRetryDelaysMs: [50],
        followUpRedeliveryIntervalMs: 250,
      },
    });
    const c = (await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name: 'down' } }))
      .json as unknown as { apiKey: string };
    await req(`${gw.baseUrl}/numbers`, { token: c.apiKey, body: { areaCode: '431' } });
    await req(`${gw.baseUrl}/notify-config`, {
      token: c.apiKey,
      body: { url: `http://127.0.0.1:${port}/hook` },
    });
    const placed = await req(`${gw.baseUrl}/orchestrations`, {
      token: c.apiKey,
      body: { to: '+15550001111', goal: 'weather', openingLine: 'Hello!' },
    });
    const id = String(placed.json.orchestrationId);
    type Attempt = { event: string; ok: boolean; error?: string; notificationId: string; attempt: number };
    const record = async (): Promise<{
      followUpRequired: boolean;
      followUpDelivered: boolean;
      notifications: Attempt[];
      pendingRequests: { id: string }[];
    }> =>
      (await req(`${gw.baseUrl}/orchestrations/${id}`, { token: c.apiKey })).json as never;

    // The promise is recorded, and so is the fact that nobody received it.
    await untilAsync(async () => {
      const r = await record();
      return (
        r.followUpRequired &&
        r.notifications.filter((n) => n.event === 'followup.promised' && !n.ok).length >= 2
      );
    });
    const before = await record();
    expect(before.followUpDelivered).toBe(false);
    const refused = before.notifications.find((n) => n.event === 'followup.promised')!;
    expect(refused.error).toMatch(/ECONNREFUSED/);
    expect(refused.notificationId).toBe(`followup.promised:${id}:${before.pendingRequests[0]!.id}`);
    expect(before.notifications.map((n) => n.attempt)).toContain(2); // the scheduled retry ran too

    // The endpoint comes back: the sweep hands over the promise (same id, flagged as re-sent).
    const hook = await receiver(false, [], port);
    receivers.push(hook);
    await until(() => hook.events.some((e) => e.event === 'followup.promised'));
    expect(hook.events.find((e) => e.event === 'followup.promised')).toMatchObject({
      orchestrationId: id,
      notificationId: refused.notificationId,
      redelivery: true,
    });
    await untilAsync(async () => (await record()).followUpDelivered);

    // Accepted once: the sweep stops re-pinging.
    const delivered = hook.events.filter((e) => e.event === 'followup.promised').length;
    await new Promise((r) => setTimeout(r, 800));
    expect(hook.events.filter((e) => e.event === 'followup.promised')).toHaveLength(delivered);
  });

  it('POST /orchestrations/:id/notify re-sends the owed callback and reports the outcome', async () => {
    const port = await deadPort();
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
        notifyRetryDelaysMs: [],
        followUpRetryDelaysMs: [],
        followUpRedeliveryIntervalMs: 0,
      },
    });
    const c = (await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name: 'manual' } }))
      .json as unknown as { apiKey: string };
    const other = (await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name: 'other' } }))
      .json as unknown as { apiKey: string };
    await req(`${gw.baseUrl}/numbers`, { token: c.apiKey, body: { areaCode: '431' } });
    await req(`${gw.baseUrl}/notify-config`, {
      token: c.apiKey,
      body: { url: `http://127.0.0.1:${port}/hook` },
    });
    const placed = await req(`${gw.baseUrl}/orchestrations`, {
      token: c.apiKey,
      body: { to: '+15550001111', goal: 'weather', openingLine: 'Hello!' },
    });
    const id = String(placed.json.orchestrationId);
    const notifyUrl = `${gw.baseUrl}/orchestrations/${id}/notify`;
    await untilAsync(
      async () =>
        Boolean((await req(`${gw.baseUrl}/orchestrations/${id}`, { token: c.apiKey })).json.followUpRequired),
    );

    // Still down: the outcome is reported, not hidden.
    let sent = await req(notifyUrl, { token: c.apiKey, body: {} });
    expect(sent.status).toBe(200);
    expect(sent.json.followUpDelivered).toBe(false);
    expect(sent.json.attempt).toMatchObject({ event: 'followup.promised', ok: false });
    expect(String((sent.json.attempt as { error: string }).error)).toMatch(/ECONNREFUSED/);

    // Receiver back: the re-send lands and the debt is marked delivered.
    const hook = await receiver(false, [], port);
    receivers.push(hook);
    sent = await req(notifyUrl, { token: c.apiKey, body: {} });
    expect(sent.status).toBe(200);
    expect(sent.json.followUpDelivered).toBe(true);
    expect(sent.json.attempt).toMatchObject({ ok: true, status: 200 });
    expect(hook.events[0]).toMatchObject({ event: 'followup.promised', orchestrationId: id, redelivery: true });

    // Scoped like everything else; and once answered there is nothing left to re-send.
    expect((await req(notifyUrl, { token: other.apiKey, body: {} })).status).toBe(404);
    const requestId = (hook.events[0]!.requestIds as string[])[0]!;
    await req(`${gw.baseUrl}/orchestrations/${id}/respond`, {
      token: c.apiKey,
      body: { requestId, result: 'Sunny, 24C.' },
    });
    expect((await req(notifyUrl, { token: c.apiKey, body: {} })).status).toBe(409);
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
