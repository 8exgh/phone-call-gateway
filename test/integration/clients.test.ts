import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGateway, type Gateway } from './helpers';

const ADMIN = 'test-admin-secret';

async function req(
  url: string,
  opts: { method?: string; token?: string; body?: unknown; form?: Record<string, string> } = {},
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: opts.body
      ? JSON.stringify(opts.body)
      : opts.form
        ? new URLSearchParams(opts.form).toString()
        : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* TwiML responses are not JSON */
  }
  return { status: res.status, json, text };
}

function freshDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'pgw-clients-'));
}

describe('multi-client: admin tokens, limits, accounting', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  async function startSecured(extra: Parameters<typeof startGateway>[0] = {}): Promise<void> {
    gw = await startGateway({
      ...extra,
      serverConfig: { adminApiKey: ADMIN, dataDir: freshDataDir(), quotaCacheTtlMs: 0, ...extra.serverConfig },
    });
  }

  async function mintClient(name: string): Promise<{ id: string; apiKey: string }> {
    const res = await req(`${gw.baseUrl}/clients`, { token: ADMIN, body: { name } });
    expect(res.status).toBe(201);
    return res.json as unknown as { id: string; apiKey: string };
  }

  it('locks every client endpoint behind a token when ADMIN_API_KEY is set', async () => {
    await startSecured();
    expect((await req(`${gw.baseUrl}/orchestrations`)).status).toBe(401);
    expect((await req(`${gw.baseUrl}/sms`)).status).toBe(401);
    expect((await req(`${gw.baseUrl}/numbers`)).status).toBe(401);
    expect((await req(`${gw.baseUrl}/numbers`, { token: 'pgw_wrong' })).status).toBe(401);
    // Health stays open.
    expect((await req(`${gw.baseUrl}/health`)).status).toBe(200);
  });

  it('only the admin can mint clients; the key works immediately', async () => {
    await startSecured();
    expect((await req(`${gw.baseUrl}/clients`, { body: { name: 'jason' } })).status).toBe(401);

    const jason = await mintClient('jason');
    expect(jason.apiKey).toMatch(/^pgw_/);
    expect((await req(`${gw.baseUrl}/orchestrations`, { token: jason.apiKey })).status).toBe(200);

    const list = await req(`${gw.baseUrl}/clients`, { token: ADMIN });
    expect((list.json as unknown as unknown[]).length).toBe(1);
  });

  it('a client can register exactly one number, with overlay fallback for dry area codes', async () => {
    await startSecured({ dryAreaCodes: ['204'] });
    const jason = await mintClient('jason');

    // 204 (Winnipeg) is dry; the overlay 431 supplies the number.
    const bought = await req(`${gw.baseUrl}/numbers`, { token: jason.apiKey, body: { areaCode: '204' } });
    expect(bought.status).toBe(200);
    expect(bought.json).toMatchObject({ areaCode: '431' });
    expect(String(bought.json!.phoneNumber)).toMatch(/^\+1431/);

    // Second registration is refused.
    const again = await req(`${gw.baseUrl}/numbers`, { token: jason.apiKey, body: { areaCode: '204' } });
    expect(again.status).toBe(409);
    expect(String(again.json!.error)).toContain('number limit reached');
  });

  it('outbound is pinned to the client number and records are isolated per client', async () => {
    await startSecured();
    const jason = await mintClient('jason');
    const sean = await mintClient('sean');

    // No number yet: refused with guidance.
    const early = await req(`${gw.baseUrl}/orchestrations`, {
      token: jason.apiKey,
      body: { to: '+15550001111', goal: 'test' },
    });
    expect(early.status).toBe(400);

    await req(`${gw.baseUrl}/numbers`, { token: jason.apiKey, body: { areaCode: '431' } });
    await req(`${gw.baseUrl}/numbers`, { token: sean.apiKey, body: { areaCode: '587' } });

    // Spoofing another from-number is refused.
    const spoof = await req(`${gw.baseUrl}/sms`, {
      token: jason.apiKey,
      body: { to: '+15878998081', body: 'hi', from: '+15875550100' },
    });
    expect(spoof.status).toBe(403);

    const placed = await req(`${gw.baseUrl}/orchestrations`, {
      token: jason.apiKey,
      body: { to: '+15550001111', goal: 'say hi', openingLine: 'hi' },
    });
    expect(placed.status).toBe(202);
    expect(String(placed.json!.from)).toMatch(/^\+1431/);
    const id = String(placed.json!.orchestrationId);

    // Jason sees his record; Sean does not; admin does.
    expect((await req(`${gw.baseUrl}/orchestrations/${id}`, { token: jason.apiKey })).status).toBe(200);
    expect((await req(`${gw.baseUrl}/orchestrations/${id}`, { token: sean.apiKey })).status).toBe(404);
    expect((await req(`${gw.baseUrl}/orchestrations/${id}`, { token: ADMIN })).status).toBe(200);
    const seanList = await req(`${gw.baseUrl}/orchestrations`, { token: sean.apiKey });
    expect(seanList.json).toMatchObject({ count: 0 });

    // SMS history is scoped to the client's number.
    await req(`${gw.baseUrl}/sms`, { token: jason.apiKey, body: { to: '+15550001111', body: 'from jason' } });
    const seanSms = await req(`${gw.baseUrl}/sms`, { token: sean.apiKey });
    expect(seanSms.json).toMatchObject({ count: 0 });
    const jasonSms = await req(`${gw.baseUrl}/sms`, { token: jason.apiKey });
    expect(jasonSms.json).toMatchObject({ count: 1 });
  });

  it('routes inbound calls to the dialed number owner persona and enforces the 90h quota both ways', async () => {
    await startSecured();
    const jason = await mintClient('jason');
    await req(`${gw.baseUrl}/numbers`, { token: jason.apiKey, body: { areaCode: '431' } });
    const jasonNumber = String(
      ((await req(`${gw.baseUrl}/clients`, { token: ADMIN })).json as unknown as { phoneNumber: string }[])[0]!
        .phoneNumber,
    );

    // No persona yet: his number rejects.
    const noPersona = await req(`${gw.baseUrl}/twilio/voice`, {
      form: { CallSid: 'CA-x1', From: '+15550002222', To: jasonNumber },
    });
    expect(noPersona.text).toContain('<Reject');

    await req(`${gw.baseUrl}/inbound-config`, {
      token: jason.apiKey,
      body: { goal: 'Answer for Jason.', openingLine: 'Jason’s line, hello!' },
    });

    const answered = await req(`${gw.baseUrl}/twilio/voice`, {
      form: { CallSid: 'CA-x2', From: '+15550002222', To: jasonNumber },
    });
    expect(answered.text).toContain('<Connect>');
    const callId = /url="[^"]*\/twilio\/media\/([^"]+)"/.exec(answered.text)?.[1];
    const record = await req(`${gw.baseUrl}/orchestrations/${callId}`, { token: jason.apiKey });
    expect(record.json).toMatchObject({ direction: 'inbound', clientId: jason.id, goal: 'Answer for Jason.' });

    // Burn through the quota: seeded provider records this month.
    gw.twilioApi.seedCallRecord({ from: jasonNumber, to: '+15550002222', durationSeconds: 90 * 3600 });
    const overOut = await req(`${gw.baseUrl}/orchestrations`, {
      token: jason.apiKey,
      body: { to: '+15550001111', goal: 'test' },
    });
    expect(overOut.status).toBe(429);
    const overIn = await req(`${gw.baseUrl}/twilio/voice`, {
      form: { CallSid: 'CA-x3', From: '+15550002222', To: jasonNumber },
    });
    expect(overIn.text).toContain('<Reject');
  });

  it('accounting attributes charges per client; clients see only their own', async () => {
    await startSecured();
    const jason = await mintClient('jason');
    const sean = await mintClient('sean');
    await req(`${gw.baseUrl}/numbers`, { token: jason.apiKey, body: { areaCode: '431' } });
    await req(`${gw.baseUrl}/numbers`, { token: sean.apiKey, body: { areaCode: '587' } });
    const numbers = (await req(`${gw.baseUrl}/clients`, { token: ADMIN })).json as unknown as {
      name: string;
      phoneNumber: string;
    }[];
    const jasonNumber = numbers.find((c) => c.name === 'jason')!.phoneNumber;
    const seanNumber = numbers.find((c) => c.name === 'sean')!.phoneNumber;

    gw.twilioApi.seedCallRecord({ from: jasonNumber, to: '+15550009999', durationSeconds: 600, priceUsd: 0.14 });
    gw.twilioApi.seedCallRecord({ from: seanNumber, to: '+15550008888', durationSeconds: 60, priceUsd: 0.014 });
    gw.twilioApi.seedCallRecord({ from: '+15550007777', to: '+15550006666', durationSeconds: 60, priceUsd: 0.02 });
    await req(`${gw.baseUrl}/sms`, { token: jason.apiKey, body: { to: '+15550009999', body: 'hello' } });

    const admin = await req(`${gw.baseUrl}/accounting`, { token: ADMIN });
    expect(admin.status).toBe(200);
    const clients = admin.json!.clients as {
      name: string;
      calls: { count: number; minutes: number; costUsd: number };
      sms: { count: number };
      totalUsd: number;
    }[];
    const jasonRow = clients.find((c) => c.name === 'jason')!;
    expect(jasonRow.calls).toMatchObject({ count: 1, minutes: 10, costUsd: 0.14 });
    expect(jasonRow.sms.count).toBe(1);
    const unattributed = admin.json!.unattributed as { calls: { count: number; costUsd: number } };
    expect(unattributed.calls).toMatchObject({ count: 1, costUsd: 0.02 });

    // A client sees only their own account.
    const own = await req(`${gw.baseUrl}/accounting`, { token: jason.apiKey });
    expect(own.json!.account).toMatchObject({ name: 'jason' });
    expect((own.json as { clients?: unknown }).clients).toBeUndefined();
  });

  it('clients persist across a gateway restart (same data dir)', async () => {
    const dataDir = freshDataDir();
    gw = await startGateway({ serverConfig: { adminApiKey: ADMIN, dataDir } });
    const jason = await mintClient('jason');
    await gw.close();

    gw = await startGateway({ serverConfig: { adminApiKey: ADMIN, dataDir } });
    const res = await req(`${gw.baseUrl}/orchestrations`, { token: jason.apiKey });
    expect(res.status).toBe(200);
  });
});
