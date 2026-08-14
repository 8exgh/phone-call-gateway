import { startGateway, post, type Gateway } from './helpers';

async function get(url: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('SMS', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  it('sends an SMS from the registered number', async () => {
    gw = await startGateway();
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });

    const res = await post(`${gw.baseUrl}/sms`, { to: '+15878998081', body: 'hello from tests' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      to: '+15878998081',
      from: '+14155550100',
      body: 'hello from tests',
      status: 'queued',
    });
    expect(String(res.json.sid)).toMatch(/^SM/);
    expect(gw.twilioApi.smsMessages).toHaveLength(1);
  });

  it('rejects sends with no from-number available', async () => {
    gw = await startGateway();
    const res = await post(`${gw.baseUrl}/sms`, { to: '+15878998081', body: 'hi' });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain('no from number');
  });

  it('validates the body', async () => {
    gw = await startGateway();
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    expect((await post(`${gw.baseUrl}/sms`, { to: 'not-a-number', body: 'hi' })).status).toBe(400);
    expect((await post(`${gw.baseUrl}/sms`, { to: '+15878998081', body: '' })).status).toBe(400);
  });

  it('surfaces provider failures as 424', async () => {
    gw = await startGateway();
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    // Explicit from-number the account does not own makes the provider reject.
    const res = await post(`${gw.baseUrl}/sms`, {
      to: '+15878998081',
      body: 'hi',
      from: '+19999999999',
    });
    expect(res.status).toBe(424);
    expect(String(res.json.error)).toContain('sms send failed');
  });

  it('lists sent and received messages from the last 30 days, newest first', async () => {
    gw = await startGateway();
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });

    await post(`${gw.baseUrl}/sms`, { to: '+15878998081', body: 'outbound one' });
    gw.twilioApi.receiveSms({ from: '+15878998081', body: 'a reply!' });
    // A message older than the window must not appear.
    gw.twilioApi.receiveSms({
      from: '+15878998081',
      body: 'ancient history',
      sentAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const res = await get(`${gw.baseUrl}/sms`);
    expect(res.status).toBe(200);
    expect(res.json.days).toBe(30);
    expect(res.json.count).toBe(2);
    const messages = res.json.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ direction: 'inbound', body: 'a reply!' });
    expect(messages[1]).toMatchObject({ direction: 'outbound', body: 'outbound one' });

    // Wider window picks the old message up.
    const wide = await get(`${gw.baseUrl}/sms?days=90`);
    expect(wide.json.count).toBe(3);
  });

  it('validates the query window', async () => {
    gw = await startGateway();
    expect((await get(`${gw.baseUrl}/sms?days=0`)).status).toBe(400);
    expect((await get(`${gw.baseUrl}/sms?days=365`)).status).toBe(400);
  });
});
