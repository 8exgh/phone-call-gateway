import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { buildServer } from '../../src/server';
import { FakeTwilioApi } from '../../src/fakes/fakeTwilioApi';
import { FakeSpeechSynthesizer } from '../../src/fakes/fakeSynthesizer';
import { FakeTranscriberFactory } from '../../src/fakes/fakeTranscriber';
import { defaultCallerScript, type CallerScript } from '../../src/fakes/callerScript';
import { FakeChatClient, demoChatScript } from '../../src/fakes/fakeChatClient';
import type { SpeechSynthesizer } from '../../src/speech/synthesizer';
import type { ChatClient } from '../../src/orchestrator/chatClient';
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '../../src/protocol/messages';

export interface Gateway {
  twilioApi: FakeTwilioApi;
  baseUrl: string;
  wsUrl(path: string): string;
  close(): Promise<void>;
}

export async function startGateway(
  opts: {
    script?: CallerScript;
    synthesizer?: SpeechSynthesizer;
    chatClientFactory?: () => ChatClient;
    serverConfig?: Partial<Parameters<typeof buildServer>[1]>;
    webhookValidator?: Parameters<typeof buildServer>[0]['webhookValidator'];
    dryAreaCodes?: string[];
  } = {},
): Promise<Gateway> {
  const script = opts.script ?? defaultCallerScript;
  const twilioApi = new FakeTwilioApi({ script, framePacingMs: 0, dryAreaCodes: opts.dryAreaCodes });
  const app = await buildServer(
    {
      twilioApi,
      synthesizer: opts.synthesizer ?? new FakeSpeechSynthesizer(),
      transcriberFactory: new FakeTranscriberFactory(script),
      chatClientFactory: opts.chatClientFactory ?? (() => new FakeChatClient(demoChatScript)),
      webhookValidator: opts.webhookValidator,
    },
    // Fresh event-store dir per gateway so tests never share state or touch ./data.
    { ttsVoice: 'alloy', dataDir: mkdtempSync(path.join(tmpdir(), 'pgw-test-')), ...opts.serverConfig },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return {
    twilioApi,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: (path: string) => `ws://127.0.0.1:${port}${path}`,
    close: () => app.close(),
  };
}

export async function post(
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface Waiter {
  predicate: (msg: ServerMessage) => boolean;
  count: number;
  resolve: (msg: ServerMessage) => void;
}

/** Test client for the control WebSocket: records all events, supports waiting. */
export class ControlClient {
  readonly events: ServerMessage[] = [];
  readonly invalidMessages: string[] = [];
  private waiters: Waiter[] = [];

  private constructor(private readonly ws: WebSocket) {}

  static connect(url: string): Promise<ControlClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new ControlClient(ws);
      ws.on('open', () => resolve(client));
      ws.on('error', reject);
      ws.on('message', (data: Buffer | string) => client.onMessage(data.toString()));
    });
  }

  private onMessage(raw: string): void {
    const result = parseServerMessage(raw);
    if (!result.ok) {
      this.invalidMessages.push(`${raw} (${result.error})`);
      return;
    }
    this.events.push(result.message);
    this.waiters = this.waiters.filter((waiter) => {
      const matches = this.events.filter(waiter.predicate);
      if (matches.length >= waiter.count) {
        waiter.resolve(matches[waiter.count - 1]!);
        return false;
      }
      return true;
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolve with the count-th event (past or future) matching the predicate. */
  waitFor(
    predicate: (msg: ServerMessage) => boolean,
    opts: { count?: number; timeoutMs?: number } = {},
  ): Promise<ServerMessage> {
    const count = opts.count ?? 1;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const existing = this.events.filter(predicate);
    if (existing.length >= count) return Promise.resolve(existing[count - 1]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrappedResolve);
        reject(
          new Error(
            `timed out waiting for event; received so far: ${JSON.stringify(this.events.map((e) => e.type))}`,
          ),
        );
      }, timeoutMs);
      const wrappedResolve = (msg: ServerMessage): void => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push({ predicate, count, resolve: wrappedResolve });
    });
  }

  close(): void {
    this.ws.close();
  }
}
