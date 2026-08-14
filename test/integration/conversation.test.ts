import { startGateway, post, type Gateway } from './helpers';
import { Orchestrator } from '../../src/orchestrator/orchestrator';
import { FakeChatClient } from '../../src/fakes/fakeChatClient';
import type { ServerMessage } from '../../src/protocol/messages';

describe('LLM-orchestrated conversation (full E2E)', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  async function createCall(): Promise<string> {
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    return gw.wsUrl(String(call.json.controlUrl));
  }

  it('drives a three-turn conversation and hangs up', async () => {
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { waitForSayCompleted: true }, // let the opening line finish
        { speak: { text: 'Hello, who is this?', durationMs: 1500 } },
        { waitForSayCompleted: true }, // reply 1
        { pauseMs: 200 },
        { speak: { text: 'I do not want any of this!', durationMs: 1600, amplitudeDb: -10 } },
        { waitForSayCompleted: true }, // reply 2
        { pauseMs: 300 },
        { speak: { text: 'alright then, goodbye', durationMs: 1500, amplitudeDb: -28 } },
        { pauseMs: 400 },
        // Script ends; the caller keeps the line open (silence) until the agent hangs up.
      ],
    });

    const chatClient = new FakeChatClient([
      { expectUserIncludes: 'who is this', reply: 'This is a test call from the gateway project.' },
      { expectUserIncludes: '[volume: loud', reply: 'I hear you — staying calm and brief.' },
      { expectUserIncludes: 'goodbye', reply: 'Thanks for your time. Goodbye! HANGUP' },
    ]);

    const events: ServerMessage[] = [];
    const orchestrator = new Orchestrator({
      controlUrl: await createCall(),
      chatClient,
      systemPrompt: 'You are a friendly test agent.',
      openingLine: 'Hi! This is an automated test call.',
      onEvent: (e) => events.push(e),
    });

    const result = await orchestrator.run();

    expect(result.finalState).toBe('ended');
    expect(result.turns.map((t) => t.role)).toEqual([
      'agent', // opening
      'caller',
      'agent',
      'caller',
      'agent',
      'caller',
      'agent', // goodbye (HANGUP stripped)
    ]);
    expect(result.turns[6]!.text).toBe('Thanks for your time. Goodbye!');
    expect(result.turns[3]!.annotation).toContain('volume: loud');

    // The angry turn's prosody reached the LLM inline.
    expect(chatClient.receivedUserContents[1]).toMatch(/\[volume: loud, pace: (fast|normal)\]/);

    // All four says completed (none aborted) and the call ended by our hangup.
    const completed = events.filter((e) => e.type === 'say.completed');
    expect(completed).toHaveLength(4);
    expect(events.some((e) => e.type === 'say.aborted')).toBe(false);
  });

  it('ignores quiet line echo of its own speech: no false barge-in, no ghost transcript', async () => {
    gw = await startGateway({
      script: [
        { pauseMs: 200 },
        // Once the opening line is mid-playback, the line "echoes" it back
        // quietly, as real telephony does.
        { waitForAgentAudioMs: 400 },
        { speak: { text: 'this is just line echo', durationMs: 1000, amplitudeDb: -30 } },
        { pauseMs: 3600 }, // let the opening finish playing
        { hangup: true },
      ],
    });

    const events: ServerMessage[] = [];
    const orchestrator = new Orchestrator({
      controlUrl: await createCall(),
      chatClient: new FakeChatClient([]),
      systemPrompt: 'You are a test agent.',
      openingLine: 'This is a long opening line that keeps playing for quite a while now.',
      onEvent: (e) => events.push(e),
    });

    const result = await orchestrator.run();

    expect(result.finalState).toBe('ended');
    // The echo neither read as caller speech nor interrupted playback.
    expect(events.some((e) => e.type === 'speech.started')).toBe(false);
    expect(events.some((e) => e.type === 'say.aborted')).toBe(false);
    expect(events.filter((e) => e.type === 'say.completed')).toHaveLength(1);
    expect(gw.twilioApi.mediaClients[0]!.clearsReceived).toBe(0);
    expect(result.turns.map((t) => t.role)).toEqual(['agent']);
  });

  it('barges in when the caller talks over the agent', async () => {
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { speak: { text: 'hi there', durationMs: 900 } },
        // Wait until the opening (300ms) has played and the long reply is mid-flight...
        { waitForAgentAudioMs: 1000 },
        // ...then interrupt it.
        { speak: { text: 'stop talking please', durationMs: 1200, amplitudeDb: -12 } },
        { pauseMs: 400 },
      ],
    });

    const longReply = Array(40).fill('and this goes on').join(' ');
    const chatClient = new FakeChatClient([
      { reply: longReply },
      { expectUserIncludes: 'stop talking', reply: 'My apologies. Goodbye. HANGUP' },
    ]);

    const events: ServerMessage[] = [];
    const orchestrator = new Orchestrator({
      controlUrl: await createCall(),
      chatClient,
      systemPrompt: 'You are a rambling test agent.',
      openingLine: 'Hello!',
      onEvent: (e) => events.push(e),
    });

    const result = await orchestrator.run();

    expect(result.finalState).toBe('ended');
    const aborted = events.find((e) => e.type === 'say.aborted');
    expect(aborted).toMatchObject({ reason: 'clear' });
    expect(gw.twilioApi.mediaClients[0]!.clearsReceived).toBeGreaterThanOrEqual(1);
    // The final apology still played to completion before hangup.
    expect(result.turns.at(-1)!.text).toBe('My apologies. Goodbye.');
  });
});
