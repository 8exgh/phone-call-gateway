import { startGateway, post, type Gateway } from './helpers';
import { FakeChatClient } from '../../src/fakes/fakeChatClient';

async function postForm(
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    text: await res.text(),
  };
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const WEBHOOK_FORM = { CallSid: 'CA-external-1', From: '+15878998081', To: '+15877417105' };

describe('inbound calls', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  it('rejects incoming calls when no answering policy is set', async () => {
    gw = await startGateway();
    const res = await postForm(`${gw.baseUrl}/twilio/voice`, WEBHOOK_FORM);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('xml');
    expect(res.text).toContain('<Reject');
  });

  it('rejects webhooks that fail signature validation', async () => {
    gw = await startGateway({ webhookValidator: () => false });
    const res = await postForm(`${gw.baseUrl}/twilio/voice`, WEBHOOK_FORM);
    expect(res.status).toBe(403);
  });

  it('configures the voice webhook on purchased numbers when a public URL is set', async () => {
    gw = await startGateway({ serverConfig: { publicWssUrl: 'wss://gw.example.com' } });
    const res = await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const sid = String(res.json.sid);
    expect(gw.twilioApi.voiceWebhooks.get(sid)).toBe('https://gw.example.com/twilio/voice');
  });

  it('answers an incoming call with the standing persona, end to end', async () => {
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { waitForSayCompleted: true }, // the greeting
        { speak: { text: 'Hi, this is Dana, tell Sean the demo is at three.', durationMs: 2500 } },
        { waitForSayCompleted: true },
        { pauseMs: 300 },
        { hangup: true },
      ],
      chatClientFactory: () =>
        new FakeChatClient([
          {
            expectUserIncludes: 'demo is at three',
            reply: 'Got it, I will pass that along to Sean. Bye!',
          },
        ]),
    });

    await post(`${gw.baseUrl}/inbound-config`, {
      goal: 'Answer, find out who is calling and why, and take a message.',
      openingLine: 'Hi! You have reached the gateway. Who is calling?',
    });

    const res = await postForm(`${gw.baseUrl}/twilio/voice`, WEBHOOK_FORM);
    expect(res.status).toBe(200);
    const streamUrl = /url="([^"]+)"/.exec(res.text)?.[1];
    expect(streamUrl).toBeDefined();

    // "Twilio" connects the caller's media stream to the URL from the TwiML.
    gw.twilioApi.spawnInboundCaller(streamUrl!);

    const callId = streamUrl!.split('/').pop()!;
    await until(async () => {
      const record = (await (await fetch(`${gw.baseUrl}/orchestrations/${callId}`)).json()) as {
        status: string;
      };
      return record.status !== 'running';
    });

    const record = (await (await fetch(`${gw.baseUrl}/orchestrations/${callId}`)).json()) as {
      direction: string;
      from: string;
      to: string;
      status: string;
      reason: string;
      turns: { role: string; text: string }[];
    };
    expect(record.direction).toBe('inbound');
    expect(record.from).toBe('+15878998081');
    expect(record.to).toBe('+15877417105');
    expect(record.status).toBe('ended');
    expect(record.turns.map((t) => t.role)).toEqual(['agent', 'caller', 'agent']);
    expect(record.turns[1]!.text).toContain('demo is at three');

    // The discovery list surfaces it for polling agents.
    const list = (await (
      await fetch(`${gw.baseUrl}/orchestrations?direction=inbound`)
    ).json()) as { count: number; orchestrations: { id: string; direction: string }[] };
    expect(list.count).toBe(1);
    expect(list.orchestrations[0]).toMatchObject({ id: callId, direction: 'inbound' });
  });

  it('inbound-config can be read, replaced, and cleared', async () => {
    gw = await startGateway();
    expect(((await (await fetch(`${gw.baseUrl}/inbound-config`)).json()) as { inbound: unknown }).inbound).toBeNull();

    await post(`${gw.baseUrl}/inbound-config`, { goal: 'Take messages.' });
    const set = (await (await fetch(`${gw.baseUrl}/inbound-config`)).json()) as {
      inbound: { goal: string };
    };
    expect(set.inbound.goal).toBe('Take messages.');

    await fetch(`${gw.baseUrl}/inbound-config`, { method: 'DELETE' });
    expect(((await (await fetch(`${gw.baseUrl}/inbound-config`)).json()) as { inbound: unknown }).inbound).toBeNull();
  });
});
