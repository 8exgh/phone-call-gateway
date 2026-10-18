import { startGateway, post, type Gateway } from './helpers';
import type { SpeechSynthesizer } from '../../src/speech/synthesizer';
import { decode as mulawDecode } from '../../src/audio/mulaw';
import { rmsDbfs } from '../../src/prosody/rms';
import { TTS_FALLBACK_TEXT, ttsFallbackClip } from '../../src/speech/ttsFallbackClip';

const SPEND_LIMIT = '429 Your project has reached its configured enforced spend limit.';

/** A TTS whose every request is rejected, as during an OpenAI quota outage. */
class ExplodingSynthesizer implements SpeechSynthesizer {
  // eslint-disable-next-line require-yield
  async *synthesize(): AsyncIterable<Int16Array> {
    throw new Error(SPEND_LIMIT);
  }
}

interface OrchestrationState {
  status: string;
  reason?: string;
  errors: string[];
  turns: Array<{ role: string; text: string }>;
}

async function pollUntilSettled(url: string, timeoutMs = 10_000): Promise<OrchestrationState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = (await (await fetch(url)).json()) as OrchestrationState;
    if (state.status !== 'running') return state;
    if (Date.now() > deadline) throw new Error(`timed out; last state: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('speech synthesis failures mid-call', () => {
  let gw: Gateway;
  afterEach(async () => {
    await gw.close();
  });

  it('says the fallback phrase, then hangs up and fails the orchestration', async () => {
    gw = await startGateway({ synthesizer: new ExplodingSynthesizer() });
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const created = await post(`${gw.baseUrl}/orchestrations`, {
      to: '+15550001111',
      goal: 'Read out the alert and hang up.',
      openingLine: 'Hello, this is AlertTray. This is a critical alert.',
      tools: [],
    });
    expect(created.status).toBeLessThan(300);
    const statusUrl = created.json.statusUrl as string;

    const state = await pollUntilSettled(`${gw.baseUrl}${statusUrl}`);
    expect(state.status).toBe('failed');
    expect(state.reason).toMatch(/^tts_failed: 429/);
    expect(state.errors).toEqual([expect.stringMatching(/^tts_failed: 429 .*spend limit/)]);
    // The opening line was attempted but never heard; the callee got the canned phrase instead.
    expect(state.turns).toEqual([
      expect.objectContaining({ role: 'agent', text: expect.stringContaining('critical alert') }),
      { role: 'agent', text: TTS_FALLBACK_TEXT },
    ]);

    // The whole pre-rendered clip went down the line, and it is audible, not silence.
    const media = gw.twilioApi.mediaClients[0]!;
    const outbound = Buffer.concat(media.capturedOutbound.map((f) => Buffer.from(f)));
    expect(outbound.length).toBeGreaterThanOrEqual(ttsFallbackClip().length);
    expect(outbound.length).toBeLessThan(ttsFallbackClip().length + 8 * 500);
    expect(rmsDbfs(mulawDecode(new Uint8Array(outbound)))).toBeGreaterThan(-35);

    const health = await fetch(`${gw.baseUrl}/health`);
    expect(health.status).toBe(200);
  });
});
