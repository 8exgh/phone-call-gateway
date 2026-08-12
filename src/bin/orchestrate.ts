import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../config';
import { buildServer } from '../server';
import { buildDeps } from '../index';
import { Orchestrator } from '../orchestrator/orchestrator';
import { OpenAiChatClient } from '../orchestrator/openAiChatClient';
import { FakeChatClient } from '../fakes/fakeChatClient';
import type { ChatClient, ChatMessage } from '../orchestrator/chatClient';

/**
 * Run an LLM-orchestrated call end to end.
 *
 *   npm run orchestrate -- --to +15551234567 --goal "confirm the appointment"
 *
 * In mock mode (default) this starts an in-process gateway with a scripted
 * fake caller — no credentials or network needed. With OPENAI_API_KEY set, the
 * orchestration brain is a real LLM; otherwise a scripted fake is used.
 */

const { values } = parseArgs({
  options: {
    to: { type: 'string', default: '+15550001234' },
    goal: { type: 'string', default: 'Have a short, friendly demo conversation.' },
    'area-code': { type: 'string', default: '415' },
    voice: { type: 'string' },
    server: { type: 'string' }, // use an already-running gateway instead of in-process
    'turn-timeout': { type: 'string', default: '15000' },
    fast: { type: 'boolean', default: false }, // mock only: run faster than realtime
  },
});

/** Prints agent replies as the LLM produces them. */
class LoggingChatClient implements ChatClient {
  constructor(private readonly inner: ChatClient) {}
  async complete(messages: ChatMessage[]): Promise<string> {
    const reply = await this.inner.complete(messages);
    console.log(`Agent: ${reply.replaceAll('HANGUP', '').trim()}`);
    return reply;
  }
}

const demoScript = [
  { reply: 'This is the phone-call-gateway demo agent, just testing the audio pipeline.' },
  { reply: 'I hear you loud and clear — no worries, this is only a local demo. Keeping it short.' },
  { reply: 'Thanks for listening. Have a great day! HANGUP' },
];

async function main(): Promise<void> {
  const config = loadConfig();

  let baseUrl: string;
  let wsBase: string;
  let stopServer: (() => Promise<void>) | null = null;

  if (values.server) {
    baseUrl = values.server.replace(/\/+$/, '');
    wsBase = baseUrl.replace(/^http/, 'ws');
  } else {
    const app = await buildServer(
      buildDeps(config, { framePacingMs: values.fast ? 0 : 20 }),
      {
        publicWssUrl: config.publicWssUrl,
        ttsVoice: config.ttsVoice,
        twilioFromNumber: config.twilioFromNumber,
      },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    stopServer = () => app.close();
    console.log(`· in-process gateway (${config.mode} mode) on ${baseUrl}`);
  }

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`${path} failed (${res.status}): ${JSON.stringify(json)}`);
    return json;
  };

  if (config.twilioFromNumber) {
    console.log(`· using existing number ${config.twilioFromNumber} (skipping purchase)`);
  } else {
    const number = await post('/numbers', { areaCode: values['area-code'] });
    console.log(`· registered number ${number.phoneNumber} (area code ${values['area-code']})`);
  }

  const call = await post('/calls', { to: values.to });
  console.log(`· calling ${values.to} from ${call.from} (call ${call.callId})`);

  const innerChat: ChatClient = config.openAiApiKey
    ? new OpenAiChatClient(config.openAiApiKey, config.chatModel)
    : new FakeChatClient(demoScript);
  if (!config.openAiApiKey) {
    console.log('· no OPENAI_API_KEY: using the scripted fake LLM');
  }

  const openingLine = 'Hi! This is an automated call from the phone gateway demo.';
  const orchestrator = new Orchestrator({
    controlUrl: `${wsBase}${call.controlUrl}`,
    chatClient: new LoggingChatClient(innerChat),
    systemPrompt: `Your goal for this call: ${values.goal}`,
    openingLine,
    voice: values.voice,
    turnTimeoutMs: Number(values['turn-timeout']),
    onEvent: (event) => {
      switch (event.type) {
        case 'call.state':
          console.log(`· call ${event.state}${event.reason ? ` (${event.reason})` : ''}`);
          break;
        case 'transcript':
          console.log(
            `Caller [volume: ${event.volume.class}, pace: ${event.pace.class}` +
              `${event.stutter.detected ? ', stuttering' : ''}]: ${event.text}`,
          );
          break;
        case 'error':
          console.error(`! ${event.code}: ${event.message}`);
          break;
        default:
          break;
      }
    },
  });

  console.log(`Agent: ${openingLine}`);
  const result = await orchestrator.run();

  console.log(`\n=== call ${result.finalState}${result.reason ? ` (${result.reason})` : ''} ===`);
  for (const turn of result.turns) {
    const label = turn.role === 'agent' ? 'Agent' : `Caller ${turn.annotation ?? ''}`.trim();
    console.log(`  ${label}: ${turn.text}`);
  }

  await stopServer?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
