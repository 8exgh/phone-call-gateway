import { startGateway, post, type Gateway } from './helpers';
import { FakeChatClient } from '../../src/fakes/fakeChatClient';
import type { CallerScript } from '../../src/fakes/callerScript';

/**
 * Opt-in manners for calling businesses, learned from real calls to a car
 * dealership: the agent recited its opening over a receptionist's greeting
 * and over a phone menu, went quiet while a receptionist's short "hello?"s
 * were heard but never transcribed, and restated its request into a hold
 * every 15 seconds. Without the options, calls behave as they always have.
 */

async function pollUntil<T>(fetchState: () => Promise<T>, done: (state: T) => boolean, timeoutMs = 15_000): Promise<T> {
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
  reason?: string;
  turns: Array<{ role: string; text: string }>;
  events: string[];
}

async function finishedCall(gw: Gateway, body: Record<string, unknown>): Promise<OrchestrationState> {
  await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
  const res = await post(`${gw.baseUrl}/orchestrations`, { to: '+15551230000', goal: 'reach sales', ...body });
  expect(res.status).toBe(202);
  return pollUntil(
    async () => (await (await fetch(`${gw.baseUrl}${res.json.statusUrl}`)).json()) as OrchestrationState,
    (state) => state.status !== 'running',
  );
}

const said = (call: OrchestrationState) => call.turns.map((t) => `${t.role}: ${t.text}`);

describe('call manners for business lines (opt-in)', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  it('lets a receptionist greet first and answers them instead of reciting the opening line', async () => {
    const chat = new FakeChatClient([
      { expectUserIncludes: 'this is Tayo', reply: 'Hi Tayo, could I speak with Kyle, please?' },
      { expectUserIncludes: 'One moment', reply: 'Thank you. HANGUP' },
    ]);
    const script: CallerScript = [
      { pauseMs: 200 },
      { speak: { text: 'Lexus of Calgary, this is Tayo.', durationMs: 1200 } },
      { waitForSayCompleted: true },
      { pauseMs: 200 },
      { speak: { text: 'One moment please.', durationMs: 900 } },
      { waitForSayCompleted: true },
      { pauseMs: 300 },
      { hangup: true },
    ];
    gw = await startGateway({ script, chatClientFactory: () => chat });
    const call = await finishedCall(gw, { openingLine: 'Hi, this is Alex. Could I speak with Kyle, please?', awaitGreeting: true });

    expect(call.status).toBe('ended');
    expect(said(call)).toEqual([
      'caller: Lexus of Calgary, this is Tayo.',
      'agent: Hi Tayo, could I speak with Kyle, please?',
      'caller: One moment please.',
      'agent: Thank you.',
    ]);
    // The model knew what it had meant to say
    expect(chat.receivedUserContents[0]).toContain('Your planned opening was: "Hi, this is Alex. Could I speak with Kyle, please?"');
  }, 20_000);

  it('opens with the opening line once a greeting nobody could make out has stopped', async () => {
    const chat = new FakeChatClient([{ expectUserIncludes: 'Kyle speaking', reply: 'Hi Kyle! HANGUP' }]);
    const script: CallerScript = [
      { pauseMs: 200 },
      { speak: { text: '(a greeting the line mangles)', durationMs: 1000, unintelligible: true } },
      { waitForSayCompleted: true },
      { pauseMs: 200 },
      { speak: { text: 'Kyle speaking.', durationMs: 800 } },
      { waitForSayCompleted: true },
      { hangup: true },
    ];
    gw = await startGateway({ script, chatClientFactory: () => chat });
    const call = await finishedCall(gw, { openingLine: 'Hi, this is Alex. Could I speak with Kyle, please?', awaitGreeting: true });

    expect(said(call)).toEqual([
      'agent: Hi, this is Alex. Could I speak with Kyle, please?',
      'caller: Kyle speaking.',
      'agent: Hi Kyle!',
    ]);
    // Not over the top of them: the opening started after their speech stopped
    const stopped = call.events.findIndex((e) => e.includes('speech.stopped'));
    const opened = call.events.findIndex((e) => e.includes('say.started'));
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(opened).toBeGreaterThan(stopped);
  }, 20_000);

  it('opens on its own when nobody on the line says anything', async () => {
    const chat = new FakeChatClient([{ reply: 'Goodbye. HANGUP' }]);
    const script: CallerScript = [{ waitForSayCompleted: true }, { waitForSayCompleted: true }, { hangup: true }];
    gw = await startGateway({ script, chatClientFactory: () => chat });
    const call = await finishedCall(gw, { openingLine: 'Hello, is anyone there?', awaitGreeting: true, silenceTimeoutMs: 300 });

    expect(said(call)[0]).toBe('agent: Hello, is anyone there?');
  }, 20_000);

  it('says it did not catch that when someone is heard but no words come through', async () => {
    const chat = new FakeChatClient([
      // One sentence, so it plays as one say and the scripted caller stays in step
      { expectUserIncludes: 'could not be made out', reply: "Sorry, I didn't catch that, is Kyle in?" },
      { expectUserIncludes: 'Yes, speaking', reply: 'Great. HANGUP' },
    ]);
    const script: CallerScript = [
      { waitForSayCompleted: true },
      { pauseMs: 200 },
      { speak: { text: '(hello?)', durationMs: 500, unintelligible: true } },
      { waitForSayCompleted: true },
      { pauseMs: 200 },
      { speak: { text: 'Yes, speaking.', durationMs: 700 } },
      { waitForSayCompleted: true },
      { hangup: true },
    ];
    gw = await startGateway({ script, chatClientFactory: () => chat });
    const call = await finishedCall(gw, { openingLine: 'Hi, is Kyle in?', promptOnUnclearSpeech: true });

    expect(call.status).toBe('ended');
    expect(said(call)).toEqual([
      'agent: Hi, is Kyle in?',
      "agent: Sorry, I didn't catch that, is Kyle in?",
      'caller: Yes, speaking.',
      'agent: Great.',
    ]);
  }, 20_000);

  it('stays as it was without the options: unclear speech gets no turn, the opening is immediate', async () => {
    // An unexpected turn would break this script and fail the call
    const chat = new FakeChatClient([{ expectUserIncludes: 'Yes, speaking', reply: 'Great. HANGUP' }]);
    const script: CallerScript = [
      { waitForSayCompleted: true },
      { pauseMs: 200 },
      { speak: { text: '(hello?)', durationMs: 500, unintelligible: true } },
      { pauseMs: 2500 },
      { speak: { text: 'Yes, speaking.', durationMs: 700 } },
      { waitForSayCompleted: true },
      { hangup: true },
    ];
    gw = await startGateway({ script, chatClientFactory: () => chat });
    const call = await finishedCall(gw, { openingLine: 'Hi, is Kyle in?' });

    expect(call.status).toBe('ended');
    expect(said(call)).toEqual(['agent: Hi, is Kyle in?', 'caller: Yes, speaking.', 'agent: Great.']);
  }, 20_000);

  it('takes the silence before re-engaging from the call', async () => {
    const chat = new FakeChatClient([{ expectUserIncludes: 'silent for a while', reply: 'Are you still there? HANGUP' }]);
    const script: CallerScript = [{ waitForSayCompleted: true }, { waitForSayCompleted: true }, { hangup: true }];
    gw = await startGateway({ script, chatClientFactory: () => chat });
    const call = await finishedCall(gw, { openingLine: 'Hello?', silenceTimeoutMs: 300 });

    expect(said(call)).toEqual(['agent: Hello?', 'agent: Are you still there?']);
  }, 20_000);

  it('refuses a silence longer than two minutes', async () => {
    gw = await startGateway();
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const res = await post(`${gw.baseUrl}/orchestrations`, { to: '+15551230000', silenceTimeoutMs: 500_000 });
    expect(res.status).toBe(400);
  });
});
