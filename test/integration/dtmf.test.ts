import { startGateway, post, ControlClient, type Gateway } from './helpers';
import { dtmfDurationMs } from '../../src/audio/dtmf';
import { Orchestrator } from '../../src/orchestrator/orchestrator';
import { FakeChatClient } from '../../src/fakes/fakeChatClient';
import type { ServerMessage } from '../../src/protocol/messages';
import type { FakeTwilioMediaClient } from '../../src/fakes/fakeTwilioMediaClient';

function outboundDurationMs(client: FakeTwilioMediaClient): number {
  return client.capturedOutbound.reduce((sum, f) => sum + f.length, 0) / 8;
}

describe('DTMF', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  async function activeCall(): Promise<{ control: ControlClient; media: FakeTwilioMediaClient }> {
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    const control = await ControlClient.connect(gw.wsUrl(String(call.json.controlUrl)));
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'active');
    return { control, media: gw.twilioApi.mediaClients[0]! };
  }

  it('sendDigits plays in-band tones with the say lifecycle', async () => {
    gw = await startGateway({ script: [{ pauseMs: 100 }] });
    const { control, media } = await activeCall();

    control.send({ type: 'sendDigits', id: 'd1', digits: '1w2#' });
    await control.waitFor((m) => m.type === 'say.started' && m.id === 'd1');
    await control.waitFor((m) => m.type === 'say.completed' && m.id === 'd1');

    expect(Math.abs(outboundDurationMs(media) - dtmfDurationMs('1w2#'))).toBeLessThanOrEqual(20);

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });

  it('rejects invalid digit strings without killing the socket', async () => {
    gw = await startGateway({ script: [{ pauseMs: 100 }] });
    const { control } = await activeCall();

    control.send({ type: 'sendDigits', id: 'bad', digits: '1E2' } as never);
    const err = await control.waitFor((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'invalid_message' });

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });

  it('caller keypresses arrive as dtmf events', async () => {
    gw = await startGateway({ script: [{ pauseMs: 200 }, { pressDigits: '42' }, { pauseMs: 400 }] });
    const { control } = await activeCall();

    const first = await control.waitFor((m) => m.type === 'dtmf');
    expect(first).toMatchObject({ digit: '4' });
    const second = await control.waitFor((m) => m.type === 'dtmf' && m.digit === '2');
    expect(second).toMatchObject({ digit: '2' });

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });

  it('E2E: the LLM reads pressed keys and presses keys back via PRESS()', async () => {
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { waitForSayCompleted: true }, // opening line
        { pressDigits: '42' },
        { pauseMs: 2000 }, // line stays open while the agent replies and dials
      ],
    });

    const chatClient = new FakeChatClient([
      {
        expectUserIncludes: 'pressed keys: 42',
        reply: 'Got it, dialing the extension now. PRESS(1w2) HANGUP',
      },
    ]);

    const events: ServerMessage[] = [];
    const orchestrator = new Orchestrator({
      controlUrl: await (async () => {
        await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
        const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
        return gw.wsUrl(String(call.json.controlUrl));
      })(),
      chatClient,
      systemPrompt: 'You are an IVR-navigating test agent.',
      openingLine: 'Hello!',
      dtmfFlushMs: 60,
      onEvent: (e) => events.push(e),
    });

    const result = await orchestrator.run();

    expect(result.finalState).toBe('ended');
    expect(result.reason).toBe('hangup'); // hangup fired only after the digits played
    expect(result.turns).toEqual([
      { role: 'agent', text: 'Hello!' },
      { role: 'caller', text: '[pressed 42]' },
      { role: 'agent', text: 'Got it, dialing the extension now.' },
      { role: 'agent', text: '[pressed 1w2]' },
    ]);
    // The spoken sentence and the digit send both completed, none aborted.
    expect(events.filter((e) => e.type === 'say.completed')).toHaveLength(3);
    expect(events.some((e) => e.type === 'say.aborted')).toBe(false);
  });
});
