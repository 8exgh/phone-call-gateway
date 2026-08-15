import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import { randomUUID } from 'node:crypto';
import { buildRejectTwiml, buildStreamTwiml } from './telephony/twiml';
import { z } from 'zod';
import { CallRegistry } from './call/callRegistry';
import { CallSession } from './call/callSession';
import { handleControlConnection } from './call/controlSocket';
import { Orchestrator, type ConversationTurn } from './orchestrator/orchestrator';
import type { ServerMessage } from './protocol/messages';
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
  /**
   * Twilio webhook signature check (X-Twilio-Signature). When absent, inbound
   * webhooks are accepted unverified (mock mode / no auth token configured).
   */
  webhookValidator?: (opts: {
    signature: string | undefined;
    url: string;
    params: Record<string, string>;
  }) => boolean;
}

export interface ServerConfig {
  /** Public wss:// base URL for Twilio to reach us; defaults to ws://127.0.0.1:<bound port>. */
  publicWssUrl?: string;
  ttsVoice: string;
  /** Fallback from-number when none registered and none given. */
  twilioFromNumber?: string;
  /** Default standing policy for answering incoming calls; unset = reject them. */
  inboundGoal?: string;
  inboundOpeningLine?: string;
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

const smsBodySchema = z.object({
  to: z.string().regex(/^\+\d{8,15}$/, 'to must be E.164, e.g. +14155550100'),
  body: z.string().min(1).max(1600),
  from: z.string().optional(),
});

const smsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const orchestrationBodySchema = z.object({
  to: z.string().min(3),
  from: z.string().optional(),
  goal: z.string().default('Have a short, friendly conversation, then wrap up politely.'),
  openingLine: z.string().optional(),
  voice: z.string().optional(),
});

const inboundConfigBodySchema = z.object({
  goal: z.string().min(1),
  openingLine: z.string().optional(),
  voice: z.string().optional(),
});

const orchestrationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  direction: z.enum(['inbound', 'outbound']).optional(),
  status: z.enum(['running', 'ended', 'failed']).optional(),
});

interface OrchestrationRecord {
  id: string;
  direction: 'inbound' | 'outbound';
  startedAt: string;
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
  /** Compact timeline of every control event, for post-call diagnosis. */
  events: string[];
}

const EVENT_TIMELINE_LIMIT = 800;

function describeEvent(event: ServerMessage): string {
  switch (event.type) {
    case 'call.state':
      return `call.state ${event.state}${event.reason ? ` (${event.reason})` : ''}`;
    case 'say.started':
    case 'say.completed':
      return `${event.type} ${event.id}`;
    case 'say.aborted':
      return `say.aborted ${event.id} (${event.reason})`;
    case 'speech.started':
    case 'speech.stopped':
      return `${event.type} at ${event.atMs}ms`;
    case 'transcript':
      return `transcript [${event.volume.class}, ${event.pace.class}] "${event.text}"`;
    case 'transcript.delta':
      return `delta "${event.text}"`;
    case 'dtmf':
      return `dtmf ${event.digit} at ${event.atMs}ms`;
    case 'error':
      return `error ${event.code}: ${event.message}`;
    default:
      return (event as { type: string }).type;
  }
}

export async function buildServer(deps: ServerDeps, config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  // Twilio webhooks post application/x-www-form-urlencoded.
  await app.register(formbody);

  const registry = new CallRegistry();
  const ownedNumbers: PurchasedNumber[] = [];

  const wsBase = (): string => {
    if (config.publicWssUrl) return config.publicWssUrl.replace(/\/+$/, '');
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return `ws://127.0.0.1:${port}`;
  };

  /** Public https:// base (derived from the wss:// one), for Twilio webhooks. */
  const httpsBase = (): string | undefined =>
    config.publicWssUrl?.replace(/\/+$/, '').replace(/^wss/i, 'https').replace(/^ws(?!s)/i, 'http');

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
      // Point incoming calls at us right away (best effort; the number is
      // usable for outbound even if this fails).
      const base = httpsBase();
      if (base) {
        try {
          await deps.twilioApi.configureVoiceWebhook(purchased.sid, `${base}/twilio/voice`);
        } catch {
          // Outbound-only until reconfigured; not worth failing the purchase.
        }
      }
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

  app.post('/sms', async (req, reply) => {
    const parsed = smsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const from = await resolveFrom(parsed.data.from);
    if (!from) {
      return reply
        .code(400)
        .send({ error: 'no from number: register one via POST /numbers or set TWILIO_FROM_NUMBER' });
    }
    try {
      const sent = await deps.twilioApi.sendSms({ to: parsed.data.to, from, body: parsed.data.body });
      return { sid: sent.sid, status: sent.status, to: parsed.data.to, from, body: parsed.data.body };
    } catch (error) {
      return reply.code(424).send({ error: `sms send failed: ${(error as Error).message}` });
    }
  });

  // Message history, both directions (default: last 30 days). Inbound SMS
  // appear here with no webhook needed, so this is also how you "receive".
  app.get('/sms', async (req, reply) => {
    const parsed = smsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    try {
      const messages = await deps.twilioApi.listSms({
        sinceDays: parsed.data.days,
        limit: parsed.data.limit,
      });
      return { days: parsed.data.days, count: messages.length, messages };
    } catch (error) {
      return reply.code(424).send({ error: `sms list failed: ${(error as Error).message}` });
    }
  });

  const orchestrations = new Map<string, OrchestrationRecord>();

  /** Runtime override of the standing inbound answering policy. */
  let inboundConfig: { goal: string; openingLine?: string; voice?: string } | null =
    config.inboundGoal
      ? { goal: config.inboundGoal, openingLine: config.inboundOpeningLine }
      : null;

  const createOrchestrationRecord = (opts: {
    id: string;
    direction: 'inbound' | 'outbound';
    to: string;
    from: string;
    goal: string;
  }): OrchestrationRecord => {
    const record: OrchestrationRecord = {
      id: opts.id,
      direction: opts.direction,
      startedAt: new Date().toISOString(),
      to: opts.to,
      from: opts.from,
      goal: opts.goal,
      status: 'running',
      turns: [],
      liveTranscript: [],
      errors: [],
      events: [],
    };
    orchestrations.set(record.id, record);
    return record;
  };

  const runOrchestrator = (
    record: OrchestrationRecord,
    opts: { openingLine?: string; voice?: string },
  ): void => {
    const startedAt = Date.now();
    const orchestrator = new Orchestrator({
      controlUrl: `${localWsBase()}/control/${record.id}`,
      chatClient: deps.chatClientFactory(),
      systemPrompt:
        record.direction === 'inbound'
          ? `You are ANSWERING an incoming call from ${record.from}. ${record.goal}`
          : `Your goal for this call: ${record.goal}`,
      openingLine: opts.openingLine,
      voice: opts.voice,
      turnTimeoutMs: 15_000,
      onEvent: (event) => {
        if (record.events.length < EVENT_TIMELINE_LIMIT) {
          record.events.push(`${Date.now() - startedAt}ms ${describeEvent(event)}`);
        }
        if (event.type === 'transcript') {
          const stutter = event.stutter.detected ? ', stuttering' : '';
          record.liveTranscript.push(
            `[${event.volume.class}, ${event.pace.class}${stutter}] ${event.text}`,
          );
        } else if (event.type === 'dtmf') {
          record.liveTranscript.push(`[key] ${event.digit}`);
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
  };

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

    const record = createOrchestrationRecord({
      id: started.callId,
      direction: 'outbound',
      to: parsed.data.to,
      from,
      goal: parsed.data.goal,
    });
    runOrchestrator(record, { openingLine: parsed.data.openingLine, voice: parsed.data.voice });

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

  // Discovery surface: how a polling agent notices calls it did not place
  // (notably answered inbound calls). Newest first; summaries only.
  app.get('/orchestrations', async (req, reply) => {
    const parsed = orchestrationListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    const records = [...orchestrations.values()]
      .filter((r) => !parsed.data.direction || r.direction === parsed.data.direction)
      .filter((r) => !parsed.data.status || r.status === parsed.data.status)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, parsed.data.limit)
      .map((r) => ({
        id: r.id,
        direction: r.direction,
        startedAt: r.startedAt,
        to: r.to,
        from: r.from,
        goal: r.goal,
        status: r.status,
        reason: r.reason,
        turnCount: r.turns.length,
        statusUrl: `/orchestrations/${r.id}`,
      }));
    return { count: records.length, orchestrations: records };
  });

  // Standing policy for answering incoming calls. Survives until restart;
  // the INBOUND_GOAL env var provides the boot-time default.
  app.post('/inbound-config', async (req, reply) => {
    const parsed = inboundConfigBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    inboundConfig = parsed.data;
    return { inbound: inboundConfig };
  });

  app.get('/inbound-config', async () => ({ inbound: inboundConfig }));

  app.delete('/inbound-config', async () => {
    inboundConfig = null;
    return { inbound: null };
  });

  // Twilio hits this when someone dials one of our numbers. Answer with a
  // media-stream TwiML and hand the call to the standing inbound persona.
  app.post('/twilio/voice', async (req, reply) => {
    const params = (req.body ?? {}) as Record<string, string>;
    if (deps.webhookValidator) {
      const url = `${httpsBase() ?? `http://${req.headers.host ?? 'localhost'}`}/twilio/voice`;
      const signature = req.headers['x-twilio-signature'];
      const ok = deps.webhookValidator({
        signature: typeof signature === 'string' ? signature : undefined,
        url,
        params,
      });
      if (!ok) return reply.code(403).send({ error: 'invalid twilio signature' });
    }

    reply.type('text/xml');
    if (!inboundConfig) return buildRejectTwiml();

    const callId = randomUUID();
    const session = new CallSession(callId, {
      synthesizer: deps.synthesizer,
      transcriberFactory: deps.transcriberFactory,
      twilioApi: deps.twilioApi,
      defaultVoice: config.ttsVoice,
    });
    if (typeof params.CallSid === 'string' && params.CallSid.length > 0) {
      session.setDialing(params.CallSid);
    }
    registry.set(callId, session);

    const record = createOrchestrationRecord({
      id: callId,
      direction: 'inbound',
      to: params.To ?? ownedNumbers.at(-1)?.phoneNumber ?? 'unknown',
      from: params.From ?? 'unknown',
      goal: inboundConfig.goal,
    });
    runOrchestrator(record, {
      openingLine: inboundConfig.openingLine,
      voice: inboundConfig.voice,
    });

    return buildStreamTwiml(`${wsBase()}/twilio/media/${callId}`);
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
