import { startGateway, post, ControlClient, type Gateway } from './helpers';

describe('call lifecycle', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  it('provisions a number, places a call, reaches active, and hangs up', async () => {
    gw = await startGateway({ script: [{ pauseMs: 200 }] });

    const number = await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    expect(number.status).toBe(200);
    expect(number.json.phoneNumber).toMatch(/^\+1415/);
    expect(String(number.json.sid)).toMatch(/^PN/);

    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    expect(call.status).toBe(200);
    expect(call.json.from).toBe(number.json.phoneNumber);
    const controlUrl = String(call.json.controlUrl);
    const callId = String(call.json.callId);

    const control = await ControlClient.connect(gw.wsUrl(controlUrl));
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'dialing');
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'active');

    const status = (await (await fetch(`${gw.baseUrl}/calls/${callId}`)).json()) as {
      state: string;
    };
    expect(status.state).toBe('active');

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ending');
    const ended = await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    expect(ended).toMatchObject({ reason: 'hangup' });
    expect(control.invalidMessages).toEqual([]);
    control.close();
  });

  it('ends the call when the remote side hangs up', async () => {
    gw = await startGateway({ script: [{ pauseMs: 100 }, { hangup: true }] });
    await post(`${gw.baseUrl}/numbers`, { areaCode: '646' });
    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    const control = await ControlClient.connect(gw.wsUrl(String(call.json.controlUrl)));
    const ended = await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    expect(ended).toMatchObject({ reason: 'remote_hangup' });
    control.close();
  });

  it('rejects calls when no from number exists', async () => {
    gw = await startGateway();
    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    expect(call.status).toBe(400);
    expect(String(call.json.error)).toContain('from number');
  });

  it('rejects a second control client for the same call', async () => {
    gw = await startGateway({ script: [{ pauseMs: 200 }] });
    await post(`${gw.baseUrl}/numbers`, { areaCode: '212' });
    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    const controlUrl = String(call.json.controlUrl);

    const first = await ControlClient.connect(gw.wsUrl(controlUrl));
    await first.waitFor((m) => m.type === 'call.state' && m.state === 'active');
    const second = await ControlClient.connect(gw.wsUrl(controlUrl));
    await second.waitFor((m) => m.type === 'error' && m.code === 'control_busy');

    first.send({ type: 'hangup' });
    await first.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    first.close();
    second.close();
  });

  it('reports unknown calls on both REST and control socket', async () => {
    gw = await startGateway();
    expect((await fetch(`${gw.baseUrl}/calls/nope`)).status).toBe(404);
    const client = await ControlClient.connect(gw.wsUrl('/control/nope'));
    await client.waitFor((m) => m.type === 'error' && m.code === 'unknown_call');
    client.close();
  });

  it('validates request bodies', async () => {
    gw = await startGateway();
    expect((await post(`${gw.baseUrl}/numbers`, { areaCode: '41' })).status).toBe(400);
    expect((await post(`${gw.baseUrl}/calls`, {})).status).toBe(400);
  });
});
