import { startGateway, post, type Gateway } from './helpers';
import { FakeChatClient } from '../../src/fakes/fakeChatClient';

async function pollUntil<T>(
  fetchState: () => Promise<T>,
  done: (state: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await fetchState();
    if (done(state)) return state;
    if (Date.now() > deadline) throw new Error(`timed out; last state: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface OrchestrationState {
  status: string;
  turns: Array<{ role: string; text: string; annotation?: string }>;
  liveTranscript: string[];
}

describe('one-shot orchestrations API', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  it('runs a complete LLM-driven call from a single POST', async () => {
    gw = await startGateway({
      chatClientFactory: () =>
        new FakeChatClient([
          { reply: 'This is your assistant calling for a quick demo.' },
          { reply: 'Understood — keeping it brief.' },
          { reply: 'Thanks for your time. Goodbye! HANGUP' },
        ]),
    });
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });

    const res = await post(`${gw.baseUrl}/orchestrations`, {
      to: '+15551230000',
      goal: 'demo the gateway',
      openingLine: 'Hello! This is a demo call.',
    });
    expect(res.status).toBe(202);
    expect(res.json.status).toBe('running');
    const statusUrl = `${gw.baseUrl}${res.json.statusUrl}`;

    const finished = await pollUntil(
      async () => (await (await fetch(statusUrl)).json()) as OrchestrationState,
      (state) => state.status !== 'running',
    );

    expect(finished.status).toBe('ended');
    // Opening + 3 replies, interleaved with the 3 scripted caller turns.
    const roles = finished.turns.map((t) => t.role);
    expect(roles.filter((r) => r === 'agent')).toHaveLength(4);
    expect(roles.filter((r) => r === 'caller')).toHaveLength(3);
    // Prosody annotations surfaced both in the final turns and the live view.
    const angryTurn = finished.turns.find((t) => t.annotation?.includes('volume: loud'));
    expect(angryTurn).toBeDefined();
    expect(finished.liveTranscript.some((line) => line.includes('[loud,'))).toBe(true);
  });

  it('rejects orchestrations without a from number', async () => {
    gw = await startGateway();
    const res = await post(`${gw.baseUrl}/orchestrations`, { to: '+15551230000' });
    expect(res.status).toBe(400);
  });

  it('404s for unknown orchestration ids', async () => {
    gw = await startGateway();
    expect((await fetch(`${gw.baseUrl}/orchestrations/nope`)).status).toBe(404);
  });
});
