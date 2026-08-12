import { startGateway, post, ControlClient, type Gateway } from './helpers';
import type { SpeechSynthesizer, SynthesizeOptions } from '../../src/speech/synthesizer';
import { FakeSpeechSynthesizer } from '../../src/fakes/fakeSynthesizer';

/** Fails on the first say, then behaves normally. */
class FlakySynthesizer implements SpeechSynthesizer {
  private failed = false;
  private readonly inner = new FakeSpeechSynthesizer();

  // eslint-disable-next-line require-yield
  async *synthesize(text: string, opts?: SynthesizeOptions): AsyncIterable<Int16Array> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('upstream TTS 500');
    }
    yield* this.inner.synthesize(text, opts);
  }
}

describe('error paths', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  async function activeCall(): Promise<ControlClient> {
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    const control = await ControlClient.connect(gw.wsUrl(String(call.json.controlUrl)));
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'active');
    return control;
  }

  it('marks the call failed when the media socket drops without a stop', async () => {
    gw = await startGateway({ script: [{ pauseMs: 200 }] });
    const control = await activeCall();

    gw.twilioApi.mediaClients[0]!.dropConnection();

    const failed = await control.waitFor((m) => m.type === 'call.state' && m.state === 'failed');
    expect(failed).toMatchObject({ reason: 'media_disconnected' });
    control.close();
  });

  it('surfaces a TTS failure without killing the call', async () => {
    gw = await startGateway({ script: [{ pauseMs: 200 }], synthesizer: new FlakySynthesizer() });
    const control = await activeCall();

    control.send({ type: 'say', id: 'boom', text: 'this will fail' });
    const error = await control.waitFor((m) => m.type === 'error' && m.code === 'tts_failed');
    expect(error).toMatchObject({ message: 'upstream TTS 500' });
    await control.waitFor((m) => m.type === 'say.aborted' && m.id === 'boom');

    // The call is still alive and the next say works.
    control.send({ type: 'say', id: 'retry', text: 'works now' });
    await control.waitFor((m) => m.type === 'say.completed' && m.id === 'retry');

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });

  it('rejects malformed control messages without dropping the socket', async () => {
    gw = await startGateway({ script: [{ pauseMs: 200 }] });
    const control = await activeCall();

    // Send raw garbage past the typed client.
    (control as unknown as { ws: { send(d: string): void } }).ws.send('{not json');
    await control.waitFor((m) => m.type === 'error' && m.code === 'invalid_message');

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });
});
