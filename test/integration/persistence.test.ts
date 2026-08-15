import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGateway, post, type Gateway } from './helpers';
import { EventStore } from '../../src/store/eventStore';

async function get(url: string, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function until(cond: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('event-sourced persistence', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  it('orchestration history survives a gateway restart', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pgw-persist-'));
    gw = await startGateway({ serverConfig: { dataDir } });

    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const placed = await post(`${gw.baseUrl}/orchestrations`, {
      to: '+15551234567',
      goal: 'demo conversation',
    });
    const id = String(placed.json.orchestrationId);
    await until(async () => (await get(`${gw.baseUrl}/orchestrations/${id}`)).json.status !== 'running');
    const before = (await get(`${gw.baseUrl}/orchestrations/${id}`)).json;
    expect(before.status).toBe('ended');
    await gw.close();

    // Same data dir, fresh process: the record replays from the event log.
    gw = await startGateway({ serverConfig: { dataDir } });
    const after = (await get(`${gw.baseUrl}/orchestrations/${id}`)).json;
    expect(after.status).toBe('ended');
    expect(after.turns).toEqual(before.turns);
    expect(after.liveTranscript).toEqual(before.liveTranscript);
    expect((after.events as string[]).length).toBeGreaterThan(0);
  });

  it('a call left mid-flight never replays as running (crash = interrupted)', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pgw-persist-'));

    // A hard crash leaves a started event with no finish: simulate by writing
    // the log directly, then boot a gateway over it.
    new EventStore(dataDir).append('orchestration:limbo', 'orchestration.started', {
      id: 'limbo',
      direction: 'inbound',
      to: '+1666',
      from: '+1555',
      goal: 'Answer.',
      startedAt: new Date().toISOString(),
    });

    gw = await startGateway({ serverConfig: { dataDir } });
    const after = (await get(`${gw.baseUrl}/orchestrations/limbo`)).json;
    expect(after).toMatchObject({ status: 'failed', reason: 'interrupted by gateway restart' });
  });

  it('imports a legacy clients.json into the event log exactly once', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pgw-persist-'));
    const legacy = [
      {
        id: 'sean-legacy-1',
        name: 'sean',
        apiKey: 'pgw_legacykey000000000000000000000',
        createdAt: '2026-08-15T00:00:00.000Z',
        phoneNumber: '+15877417105',
        inbound: { goal: 'Answer for Sean.' },
        limits: { maxNumbers: 1, maxCallHoursPerMonth: 90 },
      },
    ];
    writeFileSync(path.join(dataDir, 'clients.json'), JSON.stringify(legacy));

    gw = await startGateway({ serverConfig: { adminApiKey: 'adm', dataDir } });
    // The legacy API key authenticates, scoped to the migrated number.
    const list = await get(`${gw.baseUrl}/clients`, 'adm');
    expect((list.json as unknown as { id: string }[])[0]).toMatchObject({ id: 'sean-legacy-1' });
    expect((await get(`${gw.baseUrl}/orchestrations`, legacy[0]!.apiKey)).status).toBe(200);

    // The admin event log shows the import; restart does not re-import.
    const events = await get(`${gw.baseUrl}/events`, 'adm');
    expect((events.json.events as { type: string }[]).some((e) => e.type === 'client.created')).toBe(true);
    await gw.close();
    gw = await startGateway({ serverConfig: { adminApiKey: 'adm', dataDir } });
    const relisted = await get(`${gw.baseUrl}/clients`, 'adm');
    expect(relisted.json as unknown as unknown[]).toHaveLength(1);
  });
});
