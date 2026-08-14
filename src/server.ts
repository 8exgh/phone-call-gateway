import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CallRegistry } from './call/callRegistry';
import { CallSession } from './call/callSession';
import { handleControlConnection } from './call/controlSocket';
import { Orchestrator, type ConversationTurn } from './orchestrator/orchestrator';
import type { ChatClient } from './orchestrator/chatClient';
import type { SpeechSynthesizer } from './speech/synthesizer';
import type { TranscriberFactory } from './speech/transcriber';
import type { PurchasedNumber, TwilioApi } from './telephony/twilioApi';

export interface ServerDeps {
  twilioApi: TwilioApi;
  synthesizer: SpeechSynthesizer;
  transcriberFactory: TranscriberFactory;
  /** One chat client per server-run orchestration (POST /orchestrations). */
  chatClientFactory: () => ChatClient;
}

export interface ServerConfig {
  /** Public wss:// base URL for Twilio to reach us; defaults to ws://127.0.0.1:<bound port>. */
  publicWssUrl?: string;
  ttsVoice: string;
  /** Fallback from-number when none registered and none given. */
  twilioFromNumber?: string;
}

const areaCodeSchema = z.string().regex(/^\d{3}$/, 'areaCode must be 3 digits');

const numbersBodySchema = z.union([
  z.object({ areaCode: areaCodeSchema }),
  z.object({
    phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'phoneNumber must be E.164, e.g. +14155550100'),
  }),
]);

const callsBodySchema = z.object({
  to: z.string().min(3),
  from: z.string().optional(),
});

const orchestrationBodySchema = z.object({
  to: z.string().min(3),
  from: z.string().optional(),
  goal: z.string().default('Have a short, friendly conversation, then wrap up politely.'),
  openingLine: z.string().optional(),
  voice: z.string().optional(),
});

interface OrchestrationRecord {
  id: string;
  to: string;
  from: string;
  goal: string;
  status: 'running' | 'ended' | 'failed';
  reason?: string;
  /** Full conversation once the call finishes. */
  turns: ConversationTurn[];
  /** Caller transcript lines observed so far, with prosody, for live polling. */
  liveTranscript: string[];
  /** In-call error events (e.g. stt_failed), so failures are visible when polling. */
  errors: string[];
}

export async function buildServer(deps: ServerDeps, config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  const registry = new CallRegistry();
  const ownedNumbers: PurchasedNumber[] = [];

  const wsBase = (): string => {
    if (config.publicWssUrl) return config.publicWssUrl.replace(/\/+$/, '');
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return `ws://127.0.0.1:${port}`;
  };

  app.get('/health', async () => ({ ok: true }));

  // Preview candidates in an area code without purchasing anything.
  app.get('/numbers/available', async (req, reply) => {
    const parsed = z.object({ areaCode: areaCodeSchema }).safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    return deps.twilioApi.searchNumbers(parsed.data.areaCode);
  });

  // Purchase: {areaCode} buys the first available match; {phoneNumber} buys
  // that exact number (typically picked from GET /numbers/available).
  app.post('/numbers', async (req, reply) => {
    const parsed = numbersBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'body must be {"areaCode": "415"} or {"phoneNumber": "+1..."}' });
    }
    let phoneNumber: string;
    if ('phoneNumber' in parsed.data) {
      phoneNumber = parsed.data.phoneNumber;
    } else {
      const available = await deps.twilioApi.searchNumbers(parsed.data.areaCode);
      const first = available[0];
      if (!first) {
        return reply
          .code(404)
          .send({ error: `no numbers available in area code ${parsed.data.areaCode}` });
      }
      phoneNumber = first.phoneNumber;
    }
    try {
      const purchased = await deps.twilioApi.purchaseNumber(phoneNumber);
      ownedNumbers.push(purchased);
      return purchased;
    } catch (error) {
      return reply
        .code(424)
        .send({ error: `purchase of ${phoneNumber} failed: ${(error as Error).message}` });
    }
  });

  // Source of truth is the provider, so numbers survive gateway restarts.
  app.get('/numbers', async () => deps.twilioApi.listOwnedNumbers());

  app.delete('/numbers/:sid', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    try {
      await deps.twilioApi.releaseNumber(sid);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
    const index = ownedNumbers.findIndex((n) => n.sid === sid);
    if (index !== -1) ownedNumbers.splice(index, 1);
    return { released: sid };
  });

  const resolveFrom = async (explicit?: string): Promise<string | undefined> => {
    const remembered = explicit ?? ownedNumbers.at(-1)?.phoneNumber ?? config.twilioFromNumber;
    if (remembered) return remembered;
    // The gateway may have restarted since the number was purchased; the
    // provider still knows what we own.
    return (await deps.twilioApi.listOwnedNumbers())[0]?.phoneNumber;
  };

  const startCall = async (
    to: string,
    from: string,
  ): Promise<{ callId: string } & ({ ok: true } | { ok: false; error: string })> => {
    const callId = randomUUID();
    const session = new CallSession(callId, {
      synthesizer: deps.synthesizer,
      transcriberFactory: deps.transcriberFactory,
      twilioApi: deps.twilioApi,
      defaultVoice: config.ttsVoice,
    });
    registry.set(callId, session);
    try {
      const created = await deps.twilioApi.createCall({
        to,
        from,
        streamUrl: `${wsBase()}/twilio/media/${callId}`,
      });
      session.setDialing(created.providerCallSid);
      return { callId, ok: true };
    } catch (error) {
      session.fail(`create_call_failed: ${(error as Error).message}`);
      return { callId, ok: false, error: (error as Error).message };
    }
  };

  /** The server's own loopback address, for in-process control-socket clients. */
  const localWsBase = (): string => {
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return `ws://127.0.0.1:${port}`;
  };

  app.post('/calls', async (req, reply) => {
    const parsed = callsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const from = await resolveFrom(parsed.data.from);
    if (!from) {
      return reply
        .code(400)
        .send({ error: 'no from number: register one via POST /numbers or set TWILIO_FROM_NUMBER' });
    }
    const started = await startCall(parsed.data.to, from);
    if (!started.ok) {
      return reply.code(424).send({ error: started.error, callId: started.callId });
    }
    return { callId: started.callId, to: parsed.data.to, from, controlUrl: `/control/${started.callId}` };
  });

  const orchestrations = new Map<string, OrchestrationRecord>();

  // One-shot, agent-friendly surface: a single POST places the call and runs
  // the whole conversation server-side toward the given goal; poll the status
  // URL for the live transcript and final result.
  app.post('/orchestrations', async (req, reply) => {
    const parsed = orchestrationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const from = await resolveFrom(parsed.data.from);
    if (!from) {
      return reply
        .code(400)
        .send({ error: 'no from number: register one via POST /numbers or set TWILIO_FROM_NUMBER' });
    }
    const started = await startCall(parsed.data.to, from);
    if (!started.ok) {
      return reply.code(424).send({ error: started.error, callId: started.callId });
    }

    const record: OrchestrationRecord = {
      id: started.callId,
      to: parsed.data.to,
      from,
      goal: parsed.data.goal,
      status: 'running',
      turns: [],
      liveTranscript: [],
      errors: [],
    };
    orchestrations.set(record.id, record);

    const orchestrator = new Orchestrator({
      controlUrl: `${localWsBase()}/control/${record.id}`,
      chatClient: deps.chatClientFactory(),
      systemPrompt: `Your goal for this call: ${parsed.data.goal}`,
      openingLine: parsed.data.openingLine,
      voice: parsed.data.voice,
      turnTimeoutMs: 15_000,
      onEvent: (event) => {
        if (event.type === 'transcript') {
          const stutter = event.stutter.detected ? ', stuttering' : '';
          record.liveTranscript.push(
            `[${event.volume.class}, ${event.pace.class}${stutter}] ${event.text}`,
          );
        } else if (event.type === 'error') {
          record.errors.push(`${event.code}: ${event.message}`);
        }
      },
    });
    void orchestrator
      .run()
      .then((result) => {
        record.status = result.finalState;
        record.reason = result.reason;
        record.turns = result.turns;
      })
      .catch((error: Error) => {
        record.status = 'failed';
        record.reason = error.message;
      });

    return reply.code(202).send({
      orchestrationId: record.id,
      callId: record.id,
      to: record.to,
      from,
      goal: record.goal,
      status: record.status,
      statusUrl: `/orchestrations/${record.id}`,
    });
  });

  app.get('/orchestrations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = orchestrations.get(id);
    if (!record) return reply.code(404).send({ error: 'no such orchestration' });
    return record;
  });

  app.get('/calls/:callId', async (req, reply) => {
    const { callId } = req.params as { callId: string };
    const session = registry.get(callId);
    if (!session) return reply.code(404).send({ error: 'no such call' });
    return { callId, state: session.currentState };
  });

  app.delete('/calls/:callId', async (req, reply) => {
    const { callId } = req.params as { callId: string };
    const session = registry.get(callId);
    if (!session) return reply.code(404).send({ error: 'no such call' });
    void session.hangup();
    return reply.code(202).send({ callId, state: session.currentState });
  });

  await app.register(async (instance) => {
    instance.get('/twilio/media/:callId', { websocket: true }, (socket, req) => {
      const { callId } = req.params as { callId: string };
      const session = registry.get(callId);
      if (!session) {
        socket.close();
        return;
      }
      session.attachMediaWs(socket);
    });

    instance.get('/control/:callId', { websocket: true }, (socket, req) => {
      const { callId } = req.params as { callId: string };
      handleControlConnection(socket, registry.get(callId));
    });
  });

  return app;
}
