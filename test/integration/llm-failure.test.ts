import { startGateway, post, type Gateway } from './helpers';
import type { ChatClient, ChatDelta, ChatMessage } from '../../src/orchestrator/chatClient';

const SPEND_LIMIT = '429 Your project has reached its configured enforced spend limit.';

/** An LLM whose every request is rejected, as during an OpenAI quota outage. */
class ExplodingChatClient implements ChatClient {
  async complete(_messages: ChatMessage[]): Promise<string> {
    throw new Error(SPEND_LIMIT);
  }
  // eslint-disable-next-line require-yield
  async *streamTurn(): AsyncIterable<ChatDelta> {
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

describe('LLM failures mid-call', () => {
  let gw: Gateway;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  beforeAll(() => process.on('unhandledRejection', onRejection));
  afterAll(() => process.off('unhandledRejection', onRejection));
  afterEach(async () => {
    await gw.close();
  });

  it('fails that orchestration and hangs up instead of crashing the gateway', async () => {
    gw = await startGateway({ chatClientFactory: () => new ExplodingChatClient() });
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    // No opening line: the very first LLM turn is asked for as soon as the call connects.
    const created = await post(`${gw.baseUrl}/orchestrations`, { to: '+15550001111', goal: 'Book a table for two.' });
    expect(created.status).toBeLessThan(300);
    const statusUrl = created.json.statusUrl as string;

    const state = await pollUntilSettled(`${gw.baseUrl}${statusUrl}`);
    expect(state.status).toBe('failed');
    expect(state.reason).toMatch(/^llm_failed: 429/);
    expect(state.errors).toEqual([expect.stringMatching(/^llm_failed: 429 .*spend limit/)]);
    expect(state.turns).toEqual([
      expect.objectContaining({ role: 'agent', text: 'Sorry, something went wrong on my end. Goodbye.' }),
    ]);
    expect(rejections).toEqual([]);

    // The gateway is still serving other work afterwards.
    const health = await fetch(`${gw.baseUrl}/health`);
    expect(health.status).toBe(200);
  });
});
