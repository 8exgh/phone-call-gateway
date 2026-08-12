import { startGateway, post, ControlClient, type Gateway } from './helpers';
import { decode as mulawDecode } from '../../src/audio/mulaw';
import { rmsDbfs } from '../../src/prosody/rms';
import { fakeSynthesisDurationMs } from '../../src/fakes/fakeSynthesizer';
import type { FakeTwilioMediaClient } from '../../src/fakes/fakeTwilioMediaClient';

function outboundDurationMs(client: FakeTwilioMediaClient): number {
  const bytes = client.capturedOutbound.reduce((sum, f) => sum + f.length, 0);
  return bytes / 8; // 8kHz mu-law: 8 bytes per ms
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('TTS path', () => {
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

  it('synthesizes a say into the call with correct duration and lifecycle', async () => {
    gw = await startGateway({ script: [{ pauseMs: 100 }] });
    const { control, media } = await activeCall();

    const text = 'hello there my friend';
    control.send({ type: 'say', id: 's1', text });
    await control.waitFor((m) => m.type === 'say.started' && m.id === 's1');
    await control.waitFor((m) => m.type === 'say.completed' && m.id === 's1');

    // 4 words x 300ms/word from the fake synthesizer, +/- one 20ms frame.
    const expected = fakeSynthesisDurationMs(text);
    expect(Math.abs(outboundDurationMs(media) - expected)).toBeLessThanOrEqual(20);

    // The audio actually carries energy (it is not silence).
    const all = new Uint8Array(media.capturedOutbound.flatMap((f) => Array.from(f)));
    expect(rmsDbfs(mulawDecode(all))).toBeGreaterThan(-30);

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });

  it('plays queued says in FIFO order', async () => {
    gw = await startGateway({ script: [{ pauseMs: 100 }] });
    const { control } = await activeCall();

    control.send({ type: 'say', id: 'a', text: 'first message here' });
    control.send({ type: 'say', id: 'b', text: 'second one' });
    await control.waitFor((m) => m.type === 'say.completed' && m.id === 'b');
    await control.waitFor((m) => m.type === 'say.completed' && m.id === 'a');

    const order = control.events
      .filter((m) => m.type === 'say.started' || m.type === 'say.completed')
      .map((m) => `${m.type}:${(m as { id: string }).id}`);
    expect(order.indexOf('say.started:a')).toBeLessThan(order.indexOf('say.started:b'));
    expect(order.indexOf('say.completed:a')).toBeLessThan(order.indexOf('say.completed:b'));
    expect(order.indexOf('say.started:a')).toBeLessThan(order.indexOf('say.completed:a'));

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });

  it('clear aborts the in-flight say, drops the queue, and flushes Twilio', async () => {
    gw = await startGateway({ script: [{ pauseMs: 100 }] });
    const { control, media } = await activeCall();

    // ~40 words -> 12s of fake audio: plenty of time to interrupt.
    const longText = Array(40).fill('word').join(' ');
    control.send({ type: 'say', id: 'long', text: longText });
    control.send({ type: 'say', id: 'queued', text: 'never plays' });
    await control.waitFor((m) => m.type === 'say.started' && m.id === 'long');

    control.send({ type: 'clear' });
    const abortedLong = await control.waitFor((m) => m.type === 'say.aborted' && m.id === 'long');
    expect(abortedLong).toMatchObject({ reason: 'clear' });
    await control.waitFor((m) => m.type === 'say.aborted' && m.id === 'queued');

    // Twilio received the buffer flush, and playback stopped early.
    await until(() => media.clearsReceived > 0);
    expect(outboundDurationMs(media)).toBeLessThan(fakeSynthesisDurationMs(longText));

    // The channel still works after a clear.
    control.send({ type: 'say', id: 'after', text: 'still alive' });
    await control.waitFor((m) => m.type === 'say.completed' && m.id === 'after');

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });
});
