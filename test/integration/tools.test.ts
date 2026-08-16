import { startGateway, post, type Gateway } from './helpers';
import { FakeChatClient } from '../../src/fakes/fakeChatClient';
import type { ToolRequestRecord } from '../../src/store/orchestrationLog';

async function get(url: string): Promise<Record<string, unknown>> {
  return (await (await fetch(url)).json()) as Record<string, unknown>;
}

async function until<T>(fn: () => Promise<T | null>, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('mid-call tools', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  it('holds the line, brokers the tool call, and answers with the result', async () => {
    const chatClient = new FakeChatClient([
      {
        expectUserIncludes: 'busy tomorrow',
        reply: '',
        toolCalls: [{ name: 'check_calendar', arguments: '{"query":"tomorrow"}' }],
      },
      { reply: 'He is free after three tomorrow.' },
    ]);
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { waitForSayCompleted: true }, // opening line
        { speak: { text: 'are you busy tomorrow', durationMs: 1800 } },
        { waitForSayCompleted: true }, // hold line
        { waitForSayCompleted: true }, // the answer
        { pauseMs: 400 },
        { hangup: true },
      ],
      chatClientFactory: () => chatClient,
    });

    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const placed = await post(`${gw.baseUrl}/orchestrations`, {
      to: '+15551234567',
      goal: 'Answer availability questions.',
      openingLine: 'Hello!',
    });
    const id = String(placed.json.orchestrationId);

    // The tool request surfaces on the record while the agent holds the line.
    const request = await until(async () => {
      const record = await get(`${gw.baseUrl}/orchestrations/${id}`);
      const requests = record.pendingRequests as ToolRequestRecord[];
      return requests.find((r) => r.status === 'open') ?? null;
    });
    expect(request.name).toBe('check_calendar');
    expect(request.arguments).toContain('tomorrow');

    // The "claw" fulfills it.
    const responded = await post(`${gw.baseUrl}/orchestrations/${id}/respond`, {
      requestId: request.id,
      result: 'Calendar says: free after 3pm tomorrow.',
    });
    expect(responded.status).toBe(200);
    expect(responded.json.deliveredLive).toBe(true);

    const record = await until(async () => {
      const r = await get(`${gw.baseUrl}/orchestrations/${id}`);
      return r.status !== 'running' ? r : null;
    });
    const turns = record.turns as { role: string; text: string }[];
    expect(turns.some((t) => t.text.includes('One moment'))).toBe(true);
    expect(turns.some((t) => t.text.includes('free after three'))).toBe(true);
    expect(chatClient.receivedToolResults.some((r) => r.includes('free after 3pm'))).toBe(true);
    expect((record.pendingRequests as ToolRequestRecord[])[0]!.status).toBe('answered');
    expect(record.followUpRequired).toBe(false);
  });

  it('with no result in time: promises an immediate callback, hangs up, and takes the answer post-call', async () => {
    const chatClient = new FakeChatClient([
      {
        expectUserIncludes: 'busy tomorrow',
        reply: '',
        toolCalls: [{ name: 'check_calendar', arguments: '{"query":"tomorrow"}' }],
      },
    ]);
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { waitForSayCompleted: true },
        { speak: { text: 'are you busy tomorrow', durationMs: 1800 } },
        { pauseMs: 8000 }, // stay on the line; the agent will hang up itself
      ],
      chatClientFactory: () => chatClient,
      serverConfig: { toolTimeoutMs: 300 },
    });

    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const placed = await post(`${gw.baseUrl}/orchestrations`, {
      to: '+15551234567',
      goal: 'Answer availability questions.',
      openingLine: 'Hello!',
    });
    const id = String(placed.json.orchestrationId);

    const record = await until(async () => {
      const r = await get(`${gw.baseUrl}/orchestrations/${id}`);
      return r.status !== 'running' ? r : null;
    });
    expect(record.status).toBe('ended');
    expect(record.reason).toBe('hangup'); // the agent ended the call itself
    const turns = record.turns as { role: string; text: string }[];
    expect(turns.some((t) => t.text.includes('call you back'))).toBe(true);
    expect(record.followUpRequired).toBe(true);
    const request = (record.pendingRequests as ToolRequestRecord[])[0]!;
    expect(request.status).toBe('callback_promised');

    // Post-call fulfillment acknowledges the follow-up.
    const responded = await post(`${gw.baseUrl}/orchestrations/${id}/respond`, {
      requestId: request.id,
      result: 'Free after 3pm.',
    });
    expect(responded.status).toBe(200);
    expect(responded.json.deliveredLive).toBe(false);
    const after = await get(`${gw.baseUrl}/orchestrations/${id}`);
    expect(after.followUpRequired).toBe(false);
    expect((after.pendingRequests as ToolRequestRecord[])[0]!.status).toBe('answered');
  });

  it('the voice model gets the extensive default toolset', async () => {
    const chatClient = new FakeChatClient([{ reply: 'Hi there. HANGUP' }]);
    gw = await startGateway({
      script: [{ pauseMs: 300 }, { waitForSayCompleted: true }, { pauseMs: 500 }],
      chatClientFactory: () => chatClient,
    });
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const placed = await post(`${gw.baseUrl}/orchestrations`, {
      to: '+15551234567',
      goal: 'Say hi.',
    });
    const id = String(placed.json.orchestrationId);
    await until(async () => {
      const r = await get(`${gw.baseUrl}/orchestrations/${id}`);
      return r.status !== 'running' ? r : null;
    });
    for (const name of ['check_calendar', 'run_bash', 'write_code', 'web_search', 'ask_assistant']) {
      expect(chatClient.receivedToolNames).toContain(name);
    }
  });
});
