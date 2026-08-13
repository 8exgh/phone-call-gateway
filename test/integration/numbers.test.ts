import { startGateway, post, type Gateway } from './helpers';

async function getJson(url: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url);
  return { status: res.status, json: await res.json() };
}

describe('number provisioning API', () => {
  let gw: Gateway;

  beforeEach(async () => {
    gw = await startGateway();
  });

  afterEach(async () => {
    await gw.close();
  });

  it('previews available numbers without purchasing', async () => {
    const preview = await getJson(`${gw.baseUrl}/numbers/available?areaCode=206`);
    expect(preview.status).toBe(200);
    const numbers = preview.json as Array<{ phoneNumber: string }>;
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers[0]!.phoneNumber).toMatch(/^\+1206/);
    // Nothing was bought.
    expect(gw.twilioApi.purchasedNumbers).toHaveLength(0);
  });

  it('validates the preview query', async () => {
    expect((await getJson(`${gw.baseUrl}/numbers/available?areaCode=20`)).status).toBe(400);
    expect((await getJson(`${gw.baseUrl}/numbers/available`)).status).toBe(400);
  });

  it('purchases a specific number picked from the preview', async () => {
    const preview = await getJson(`${gw.baseUrl}/numbers/available?areaCode=917`);
    const picked = (preview.json as Array<{ phoneNumber: string }>)[1]!.phoneNumber;

    const bought = await post(`${gw.baseUrl}/numbers`, { phoneNumber: picked });
    expect(bought.status).toBe(200);
    expect(bought.json.phoneNumber).toBe(picked);
    expect(String(bought.json.sid)).toMatch(/^PN/);
  });

  it('rejects bodies that are neither areaCode nor phoneNumber', async () => {
    expect((await post(`${gw.baseUrl}/numbers`, { areaCode: '41' })).status).toBe(400);
    expect((await post(`${gw.baseUrl}/numbers`, { phoneNumber: '415-555' })).status).toBe(400);
    expect((await post(`${gw.baseUrl}/numbers`, {})).status).toBe(400);
  });

  it('lists owned numbers from the provider and releases them', async () => {
    const first = await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const second = await post(`${gw.baseUrl}/numbers`, { areaCode: '206' });

    const owned = await getJson(`${gw.baseUrl}/numbers`);
    expect((owned.json as unknown[]).length).toBe(2);

    const releaseRes = await fetch(`${gw.baseUrl}/numbers/${first.json.sid}`, { method: 'DELETE' });
    expect(releaseRes.status).toBe(200);
    expect(await releaseRes.json()).toEqual({ released: first.json.sid });

    const afterRelease = await getJson(`${gw.baseUrl}/numbers`);
    expect(afterRelease.json).toEqual([
      { sid: second.json.sid, phoneNumber: second.json.phoneNumber },
    ]);

    // Releasing twice (or an unknown sid) is a 404.
    const again = await fetch(`${gw.baseUrl}/numbers/${first.json.sid}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('falls back to a provider-owned number for calls after a restart', async () => {
    // Simulate a number purchased in an earlier gateway process: it exists at
    // the provider but not in this server's session memory.
    const preexisting = await gw.twilioApi.purchaseNumber('+14155550199');

    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    expect(call.status).toBe(200);
    expect(call.json.from).toBe(preexisting.phoneNumber);
  });

  it('cannot call from a released number', async () => {
    const bought = await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    await fetch(`${gw.baseUrl}/numbers/${bought.json.sid}`, { method: 'DELETE' });

    const call = await post(`${gw.baseUrl}/calls`, {
      to: '+15551234567',
      from: String(bought.json.phoneNumber),
    });
    expect(call.status).toBe(424);
    expect(String(call.json.error)).toContain('not owned');
  });
});
