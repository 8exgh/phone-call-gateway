import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import { randomUUID } from 'node:crypto';
import { buildRejectTwiml, buildStreamTwiml } from './telephony/twiml';
import { areaCodeCandidates } from './telephony/areaCodes';
import { EventStore } from './store/eventStore';
import { ClientStore, type ClientRecord } from './store/clientStore';
import { OrchestrationLog, type OrchestrationRecord } from './store/orchestrationLog';
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
  /**
   * Admin password. When set, client endpoints require a bearer token (this
   * key, or a per-client key from POST /clients). Unset = open mode.
   */
  adminApiKey?: string;
  /** Durable state directory (client registry). Defaults to ./data. */
  dataDir?: string;
  /** How long month-usage lookups are cached (default 60s; 0 in tests). */
  quotaCacheTtlMs?: number;
  /** How long the agent holds the line for a tool result (default 25s). */
  toolTimeoutMs?: number;
  /** Timeout per webhook notification attempt (default 5s). */
  notifyTimeoutMs?: number;
  /** Tests only: allow loopback/private notify targets. */
  allowPrivateNotifyTargets?: boolean;
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

const toolDefSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().min(1).max(1000),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const orchestrationBodySchema = z.object({
  to: z.string().min(3),
  from: z.string().optional(),
  goal: z.string().default('Have a short, friendly conversation, then wrap up politely.'),
  openingLine: z.string().optional(),
  voice: z.string().optional(),
  /** Tools the voice agent may invoke mid-call; defaults to DEFAULT_TOOLS. */
  tools: z.array(toolDefSchema).max(32).optional(),
});

const respondBodySchema = z.object({
  requestId: z.string().min(1),
  result: z.string().min(1).max(8000),
});

const notifyConfigBodySchema = z.object({
  url: z.string().url().max(500),
  /** Extra headers sent with every ping (e.g. the receiver's bearer token). */
  headers: z.record(z.string().max(64), z.string().max(500)).optional(),
});

/** Refuse notify targets that would point the gateway at its own network. */
function isForbiddenNotifyTarget(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
      return true;
    }
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host);
  } catch {
    return true;
  }
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });
const objectOf = (props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  required,
});

/**
 * Default mid-call toolset: what a full assistant (an OpenClaw) can typically
 * fulfill. The gateway never executes these itself — it brokers the request
 * to whoever placed the call (poll the record's pendingRequests, run the
 * matching capability, POST the result back). Names are hints, not a rigid
 * API: the fulfiller interprets them with whatever tools it actually has.
 */
const DEFAULT_TOOLS = [
  {
    name: 'check_calendar',
    description:
      "Look up the owner's calendar: availability on a date or range, or what is scheduled.",
    parameters: objectOf({ query: str('What to look up, e.g. "free Thursday afternoon?"') }, ['query']),
  },
  {
    name: 'search_email',
    description: "Search the owner's email for a message, confirmation number, or thread.",
    parameters: objectOf({ query: str('What to find, e.g. "booking confirmation from Aloft Hotel"') }, ['query']),
  },
  {
    name: 'web_search',
    description: 'Search the web for current facts: hours, prices, addresses, news, anything public.',
    parameters: objectOf({ query: str('The search query') }, ['query']),
  },
  {
    name: 'fetch_webpage',
    description: 'Fetch and read a specific web page or URL.',
    parameters: objectOf({ url: str('The URL to read') }, ['url']),
  },
  {
    name: 'run_bash',
    description:
      "Run a shell command on the assistant's computer: math, data processing, file inspection, scripts, anything a terminal can do.",
    parameters: objectOf({ command: str('The bash command to run') }, ['command']),
  },
  {
    name: 'write_code',
    description:
      'Write and execute a program (any language) to compute, convert, generate, or analyze something.',
    parameters: objectOf({ task: str('What the program should do') }, ['task']),
  },
  {
    name: 'read_file',
    description: "Read a document or file the owner has (notes, PDFs, spreadsheets).",
    parameters: objectOf({ what: str('Which file or document, described naturally') }, ['what']),
  },
  {
    name: 'lookup_contact',
    description: "Look up a person in the owner's contacts: phone, email, address, context.",
    parameters: objectOf({ name: str('Who to look up') }, ['name']),
  },
  {
    name: 'save_note',
    description: "Save a note, reminder, or task to the owner's records so nothing is lost.",
    parameters: objectOf({ note: str('The note to save') }, ['note']),
  },
  {
    name: 'ask_assistant',
    description:
      "Anything else: ask the owner's assistant directly — it has email, calendars, files, contacts, a browser, a phone, and a full computer, and can answer or act on almost anything.",
    parameters: objectOf({ question: str('The question or request') }, ['question']),
  },
];

const inboundConfigBodySchema = z.object({
  goal: z.string().min(1),
  openingLine: z.string().optional(),
  voice: z.string().optional(),
});

const clientsBodySchema = z.object({
  name: z.string().min(1).max(60),
  /** Optionally pre-bind an already-owned number to this client. */
  phoneNumber: z.string().regex(/^\+\d{8,15}$/).optional(),
});

const accountingQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/** Approximate monthly rental for a CA/US local number (Twilio does not expose it per number). */
const NUMBER_MONTHLY_ESTIMATE_USD = 1.15;

const orchestrationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  direction: z.enum(['inbound', 'outbound']).optional(),
  status: z.enum(['running', 'ended', 'failed']).optional(),
});

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

  const eventStore = new EventStore(config.dataDir ?? './data');
  const store = new ClientStore(eventStore, config.dataDir ?? './data');

  type Auth = { kind: 'open' } | { kind: 'admin' } | { kind: 'client'; client: ClientRecord };

  /** Sends the 4xx itself and returns null when the request is not allowed. */
  const authenticate = (req: FastifyRequest, reply: FastifyReply): Auth | null => {
    if (!config.adminApiKey) return { kind: 'open' };
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      reply.code(401).send({ error: 'missing bearer token' });
      return null;
    }
    if (token === config.adminApiKey) return { kind: 'admin' };
    const client = store.findByApiKey(token);
    if (!client) {
      reply.code(401).send({ error: 'invalid token' });
      return null;
    }
    return { kind: 'client', client };
  };

  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!config.adminApiKey) {
      reply.code(400).send({ error: 'admin endpoints need ADMIN_API_KEY configured' });
      return false;
    }
    const auth = authenticate(req, reply);
    if (!auth) return false;
    if (auth.kind !== 'admin') {
      reply.code(403).send({ error: 'admin token required' });
      return false;
    }
    return true;
  };

  // ---------- usage quota (provider call history is the source of truth) ----------

  const quotaCacheTtlMs = config.quotaCacheTtlMs ?? 60_000;
  const quotaCache = new Map<string, { at: number; seconds: number }>();

  const monthCallSeconds = async (phoneNumber: string): Promise<number> => {
    const cached = quotaCache.get(phoneNumber);
    if (cached && Date.now() - cached.at < quotaCacheTtlMs) return cached.seconds;
    const monthPrefix = new Date().toISOString().slice(0, 7); // UTC YYYY-MM
    const calls = await deps.twilioApi.listCalls({ sinceDays: 32, limit: 1000 });
    const seconds = calls
      .filter((c) => c.startedAt.startsWith(monthPrefix))
      .filter((c) => c.from === phoneNumber || c.to === phoneNumber)
      .reduce((sum, c) => sum + c.durationSeconds, 0);
    quotaCache.set(phoneNumber, { at: Date.now(), seconds });
    return seconds;
  };

  const overCallQuota = async (client: ClientRecord): Promise<boolean> => {
    if (!client.phoneNumber) return false;
    const used = await monthCallSeconds(client.phoneNumber);
    return used >= client.limits.maxCallHoursPerMonth * 3600;
  };

  app.get('/health', async () => ({ ok: true }));

  // Preview candidates in an area code without purchasing anything.
  app.get('/numbers/available', async (req, reply) => {
    if (!authenticate(req, reply)) return;
    const parsed = z.object({ areaCode: areaCodeSchema }).safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    return deps.twilioApi.searchNumbers(parsed.data.areaCode);
  });

  // Purchase: {areaCode} buys the first available match — falling back to the
  // area code's same-city overlays when it is dry (204 -> 431 for Winnipeg);
  // {phoneNumber} buys that exact number. Under a client token the number is
  // bound to the client, subject to their number limit.
  app.post('/numbers', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const parsed = numbersBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'body must be {"areaCode": "415"} or {"phoneNumber": "+1..."}' });
    }
    if (auth.kind === 'client' && auth.client.numberSid) {
      return reply.code(409).send({
        error: `number limit reached (max ${auth.client.limits.maxNumbers}): you already have ${auth.client.phoneNumber}`,
      });
    }
    let phoneNumber: string;
    let areaCodeUsed: string | undefined;
    if ('phoneNumber' in parsed.data) {
      phoneNumber = parsed.data.phoneNumber;
    } else {
      const candidates = areaCodeCandidates(parsed.data.areaCode);
      let found: string | undefined;
      for (const candidate of candidates) {
        const available = await deps.twilioApi.searchNumbers(candidate);
        if (available[0]) {
          found = available[0].phoneNumber;
          areaCodeUsed = candidate;
          break;
        }
      }
      if (!found) {
        return reply.code(404).send({
          error: `no numbers available in area code ${parsed.data.areaCode} or its overlays (tried ${candidates.join(', ')})`,
        });
      }
      phoneNumber = found;
    }
    try {
      const purchased = await deps.twilioApi.purchaseNumber(phoneNumber);
      ownedNumbers.push(purchased);
      if (auth.kind === 'client') {
        store.update(auth.client.id, {
          phoneNumber: purchased.phoneNumber,
          numberSid: purchased.sid,
        });
      }
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
      return { ...purchased, ...(areaCodeUsed ? { areaCode: areaCodeUsed } : {}) };
    } catch (error) {
      return reply
        .code(424)
        .send({ error: `purchase of ${phoneNumber} failed: ${(error as Error).message}` });
    }
  });

  // Source of truth is the provider, so numbers survive gateway restarts.
  app.get('/numbers', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const numbers = await deps.twilioApi.listOwnedNumbers();
    if (auth.kind === 'client') return numbers.filter((n) => n.sid === auth.client.numberSid);
    return numbers;
  });

  app.delete('/numbers/:sid', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const { sid } = req.params as { sid: string };
    if (auth.kind === 'client' && sid !== auth.client.numberSid) {
      return reply.code(404).send({ error: 'no such number on your account' });
    }
    try {
      await deps.twilioApi.releaseNumber(sid);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
    const index = ownedNumbers.findIndex((n) => n.sid === sid);
    if (index !== -1) ownedNumbers.splice(index, 1);
    if (auth.kind === 'client') {
      store.update(auth.client.id, { phoneNumber: undefined, numberSid: undefined });
    }
    return { released: sid };
  });

  const resolveFrom = async (explicit?: string): Promise<string | undefined> => {
    const remembered = explicit ?? ownedNumbers.at(-1)?.phoneNumber ?? config.twilioFromNumber;
    if (remembered) return remembered;
    // The gateway may have restarted since the number was purchased; the
    // provider still knows what we own.
    return (await deps.twilioApi.listOwnedNumbers())[0]?.phoneNumber;
  };

  /** Per-auth from-number: clients are pinned to their registered number. */
  const resolveFromFor = async (
    auth: Auth,
    explicit: string | undefined,
    reply: FastifyReply,
  ): Promise<string | null> => {
    if (auth.kind === 'client') {
      if (!auth.client.phoneNumber) {
        reply.code(400).send({ error: 'no number registered: POST /numbers {"areaCode": "..."} first' });
        return null;
      }
      if (explicit && explicit !== auth.client.phoneNumber) {
        reply.code(403).send({ error: `from must be your registered number ${auth.client.phoneNumber}` });
        return null;
      }
      return auth.client.phoneNumber;
    }
    const from = await resolveFrom(explicit);
    if (!from) {
      reply
        .code(400)
        .send({ error: 'no from number: register one via POST /numbers or set TWILIO_FROM_NUMBER' });
      return null;
    }
    return from;
  };

  /** Sends the 429 itself when the client's monthly call hours are spent. */
  const checkCallQuota = async (auth: Auth, reply: FastifyReply): Promise<boolean> => {
    if (auth.kind !== 'client') return true;
    if (await overCallQuota(auth.client)) {
      reply.code(429).send({
        error: `monthly call time limit reached (${auth.client.limits.maxCallHoursPerMonth}h)`,
      });
      return false;
    }
    return true;
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
    const auth = authenticate(req, reply);
    if (!auth) return;
    const parsed = callsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const from = await resolveFromFor(auth, parsed.data.from, reply);
    if (!from) return;
    if (!(await checkCallQuota(auth, reply))) return;
    const started = await startCall(parsed.data.to, from);
    if (!started.ok) {
      return reply.code(424).send({ error: started.error, callId: started.callId });
    }
    return { callId: started.callId, to: parsed.data.to, from, controlUrl: `/control/${started.callId}` };
  });

  app.post('/sms', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const parsed = smsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const from = await resolveFromFor(auth, parsed.data.from, reply);
    if (!from) return;
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
    const auth = authenticate(req, reply);
    if (!auth) return;
    const parsed = smsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    try {
      let messages = await deps.twilioApi.listSms({
        sinceDays: parsed.data.days,
        limit: parsed.data.limit,
      });
      if (auth.kind === 'client') {
        const n = auth.client.phoneNumber;
        messages = n ? messages.filter((m) => m.from === n || m.to === n) : [];
      }
      return { days: parsed.data.days, count: messages.length, messages };
    } catch (error) {
      return reply.code(424).send({ error: `sms list failed: ${(error as Error).message}` });
    }
  });

  const orchestrations = new OrchestrationLog(eventStore);

  /** Runtime override of the standing inbound answering policy. */
  let inboundConfig: { goal: string; openingLine?: string; voice?: string } | null =
    config.inboundGoal
      ? { goal: config.inboundGoal, openingLine: config.inboundOpeningLine }
      : null;

  const createOrchestrationRecord = (opts: {
    id: string;
    direction: 'inbound' | 'outbound';
    clientId?: string;
    to: string;
    from: string;
    goal: string;
  }): OrchestrationRecord => orchestrations.start(opts);

  /** Live orchestrator instances, for feeding tool results into running calls. */
  const runningOrchestrators = new Map<string, Orchestrator>();

  /**
   * Fire-and-forget webhook ping to one client. Fully isolated: runs off the
   * call path, per-client URL, independent fetch with its own timeout, one
   * quiet retry, errors swallowed — a dead or slow endpoint for one client
   * can never affect another client's calls (polling remains the fallback).
   */
  const notifyClient = (clientId: string | undefined, payload: Record<string, unknown>): void => {
    if (!clientId) return;
    const client = store.get(clientId);
    const url = client?.notifyUrl;
    if (!url) return;
    const attempt = (): Promise<void> =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(client?.notifyHeaders ?? {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.notifyTimeoutMs ?? 5000),
      }).then(() => undefined);
    void attempt().catch(() =>
      new Promise((r) => setTimeout(r, 2000)).then(attempt).catch(() => undefined),
    );
  };

  const runOrchestrator = (
    record: OrchestrationRecord,
    opts: { openingLine?: string; voice?: string; tools?: z.infer<typeof toolDefSchema>[] },
  ): void => {
    const startedAt = Date.now();
    const orchestrator = new Orchestrator({
      controlUrl: `${localWsBase()}/control/${record.id}`,
      chatClient: deps.chatClientFactory(),
      systemPrompt:
        record.direction === 'inbound'
          ? `You are ANSWERING an incoming call from ${record.from}. ${record.goal}`
          : `Your goal for this call: ${record.goal}`,
      objective: record.goal,
      openingLine: opts.openingLine,
      voice: opts.voice,
      tools: opts.tools ?? DEFAULT_TOOLS,
      toolTimeoutMs: config.toolTimeoutMs,
      onToolRequest: (request) => {
        orchestrations.toolRequested(record.id, {
          id: request.id,
          name: request.name,
          arguments: request.arguments,
        });
        notifyClient(record.clientId, {
          event: 'tool.requested',
          orchestrationId: record.id,
          requestId: request.id,
          name: request.name,
          arguments: request.arguments,
          respondUrl: `/orchestrations/${record.id}/respond`,
          statusUrl: `/orchestrations/${record.id}`,
        });
      },
      onToolTimeout: (requestIds) => {
        orchestrations.followUpPromised(record.id, requestIds);
        notifyClient(record.clientId, {
          event: 'followup.promised',
          orchestrationId: record.id,
          requestIds,
          to: record.to,
          from: record.from,
          statusUrl: `/orchestrations/${record.id}`,
        });
      },
      turnTimeoutMs: 15_000,
      onEvent: (event) => {
        // The debug timeline stays in memory while the call runs and is
        // persisted in one piece with the finished event.
        if (record.events.length < EVENT_TIMELINE_LIMIT) {
          record.events.push(`${Date.now() - startedAt}ms ${describeEvent(event)}`);
        }
        if (event.type === 'transcript') {
          const stutter = event.stutter.detected ? ', stuttering' : '';
          orchestrations.line(
            record.id,
            `[${event.volume.class}, ${event.pace.class}${stutter}] ${event.text}`,
          );
        } else if (event.type === 'dtmf') {
          orchestrations.line(record.id, `[key] ${event.digit}`);
        } else if (event.type === 'error') {
          orchestrations.error(record.id, `${event.code}: ${event.message}`);
        }
      },
    });
    runningOrchestrators.set(record.id, orchestrator);
    void orchestrator
      .run()
      .then((result) => {
        orchestrations.finish(record.id, {
          status: result.finalState,
          reason: result.reason,
          turns: result.turns,
          timeline: record.events,
        });
        if (record.direction === 'inbound' || record.followUpRequired) {
          notifyClient(record.clientId, {
            event: 'call.ended',
            orchestrationId: record.id,
            direction: record.direction,
            from: record.from,
            to: record.to,
            status: record.status,
            reason: record.reason,
            followUpRequired: record.followUpRequired,
            statusUrl: `/orchestrations/${record.id}`,
          });
        }
      })
      .catch((error: Error) => {
        orchestrations.finish(record.id, {
          status: 'failed',
          reason: error.message,
          turns: [],
          timeline: record.events,
        });
      })
      .finally(() => {
        runningOrchestrators.delete(record.id);
      });
  };

  // One-shot, agent-friendly surface: a single POST places the call and runs
  // the whole conversation server-side toward the given goal; poll the status
  // URL for the live transcript and final result.
  app.post('/orchestrations', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const parsed = orchestrationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const from = await resolveFromFor(auth, parsed.data.from, reply);
    if (!from) return;
    if (!(await checkCallQuota(auth, reply))) return;
    const started = await startCall(parsed.data.to, from);
    if (!started.ok) {
      return reply.code(424).send({ error: started.error, callId: started.callId });
    }

    const record = createOrchestrationRecord({
      id: started.callId,
      direction: 'outbound',
      ...(auth.kind === 'client' ? { clientId: auth.client.id } : {}),
      to: parsed.data.to,
      from,
      goal: parsed.data.goal,
    });
    runOrchestrator(record, {
      openingLine: parsed.data.openingLine,
      voice: parsed.data.voice,
      tools: parsed.data.tools,
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
    const auth = authenticate(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const record = orchestrations.get(id);
    if (!record) return reply.code(404).send({ error: 'no such orchestration' });
    if (auth.kind === 'client' && record.clientId !== auth.client.id) {
      return reply.code(404).send({ error: 'no such orchestration' });
    }
    return record;
  });

  // Discovery surface: how a polling agent notices calls it did not place
  // (notably answered inbound calls). Newest first; summaries only.
  app.get('/orchestrations', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const parsed = orchestrationListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    const records = orchestrations
      .list()
      .filter((r) => auth.kind !== 'client' || r.clientId === auth.client.id)
      .filter((r) => !parsed.data.direction || r.direction === parsed.data.direction)
      .filter((r) => !parsed.data.status || r.status === parsed.data.status)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, parsed.data.limit)
      .map((r) => ({
        id: r.id,
        direction: r.direction,
        startedAt: r.startedAt,
        clientId: r.clientId,
        followUpRequired: r.followUpRequired,
        openRequests: r.pendingRequests.filter((q) => q.status !== 'answered').length,
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

  // Standing policy for answering incoming calls. Client tokens read/write
  // their own persisted persona (routed by which number was dialed); the
  // global fallback covers unbound numbers, with INBOUND_GOAL as boot default.
  app.post('/inbound-config', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const parsed = inboundConfigBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    if (auth.kind === 'client') {
      store.update(auth.client.id, { inbound: parsed.data });
      return { inbound: parsed.data };
    }
    inboundConfig = parsed.data;
    return { inbound: inboundConfig };
  });

  app.get('/inbound-config', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    if (auth.kind === 'client') return { inbound: auth.client.inbound ?? null };
    return { inbound: inboundConfig };
  });

  app.delete('/inbound-config', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    if (auth.kind === 'client') {
      store.update(auth.client.id, { inbound: null });
      return { inbound: null };
    }
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
    // Route by the dialed number: a bound number answers with its client's
    // persona (subject to that client's quota); unbound numbers use the
    // global fallback policy.
    const owner = params.To ? store.findByNumber(params.To) : undefined;
    const policy = owner ? (owner.inbound ?? null) : inboundConfig;
    if (!policy) return buildRejectTwiml();
    if (owner && (await overCallQuota(owner))) return buildRejectTwiml();

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
      ...(owner ? { clientId: owner.id } : {}),
      to: params.To ?? ownedNumbers.at(-1)?.phoneNumber ?? 'unknown',
      from: params.From ?? 'unknown',
      goal: policy.goal,
    });
    notifyClient(owner?.id, {
      event: 'call.inbound.started',
      orchestrationId: record.id,
      from: record.from,
      to: record.to,
      statusUrl: `/orchestrations/${record.id}`,
    });
    runOrchestrator(record, {
      openingLine: policy.openingLine,
      voice: policy.voice,
    });

    return buildStreamTwiml(`${wsBase()}/twilio/media/${callId}`);
  });

  // Where the gateway pings this client when their calls need attention
  // (tool.requested / followup.promised / call.inbound.started / call.ended).
  app.post('/notify-config', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    if (auth.kind !== 'client') {
      return reply.code(400).send({ error: 'notify-config is per-client: use a client token' });
    }
    const parsed = notifyConfigBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    if (!config.allowPrivateNotifyTargets && isForbiddenNotifyTarget(parsed.data.url)) {
      return reply.code(400).send({ error: 'notify url must be a public http(s) endpoint' });
    }
    store.update(auth.client.id, {
      notifyUrl: parsed.data.url,
      notifyHeaders: parsed.data.headers,
    });
    return { notifyUrl: parsed.data.url, headers: Object.keys(parsed.data.headers ?? {}) };
  });

  app.get('/notify-config', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    if (auth.kind !== 'client') {
      return reply.code(400).send({ error: 'notify-config is per-client: use a client token' });
    }
    return { notifyUrl: auth.client.notifyUrl ?? null };
  });

  app.delete('/notify-config', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    if (auth.kind !== 'client') {
      return reply.code(400).send({ error: 'notify-config is per-client: use a client token' });
    }
    store.update(auth.client.id, { notifyUrl: undefined, notifyHeaders: undefined });
    return { notifyUrl: null };
  });

  // ---------- admin: client management ----------

  // Mint a new client + API key. Admin only; the key is shown once here.
  app.post('/clients', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = clientsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    try {
      const client = store.create(parsed.data.name, parsed.data.phoneNumber);
      return reply.code(201).send(client);
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  app.get('/clients', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return store.list();
  });

  // Raw event-log audit view (admin): the append-only source of truth.
  app.get('/events', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        stream: z.string().optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    const events = eventStore.readRecent(parsed.data.limit, parsed.data.stream);
    return { count: events.length, events };
  });

  app.delete('/clients/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!store.remove(id)) return reply.code(404).send({ error: 'no such client' });
    // The number (if any) stays owned by the Twilio account; release it
    // separately via DELETE /numbers/:sid if it should stop billing.
    return { removed: id };
  });

  // ---------- accounting ----------

  // Charges from the provider's records (the billing source of truth),
  // attributed to whichever client's number was involved. Admin sees all
  // accounts plus unattributed traffic; a client token sees its own.
  app.get('/accounting', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const parsed = accountingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    const days = parsed.data.days;
    try {
      const [calls, messages] = await Promise.all([
        deps.twilioApi.listCalls({ sinceDays: days, limit: 1000 }),
        deps.twilioApi.listSms({ sinceDays: days, limit: 500 }),
      ]);

      const attributedCallSids = new Set<string>();
      const attributedSmsSids = new Set<string>();
      const round = (v: number): number => Math.round(v * 10000) / 10000;

      const summarize = (phoneNumber: string | undefined) => {
        const myCalls = phoneNumber
          ? calls.filter((c) => c.from === phoneNumber || c.to === phoneNumber)
          : [];
        const mySms = phoneNumber
          ? messages.filter((m) => m.from === phoneNumber || m.to === phoneNumber)
          : [];
        for (const c of myCalls) attributedCallSids.add(c.sid);
        for (const m of mySms) attributedSmsSids.add(m.sid);
        const callSeconds = myCalls.reduce((sum, c) => sum + c.durationSeconds, 0);
        const callCost = myCalls.reduce((sum, c) => sum + (c.priceUsd ?? 0), 0);
        const smsCost = mySms.reduce((sum, m) => sum + (m.priceUsd ?? 0), 0);
        const rental = phoneNumber ? NUMBER_MONTHLY_ESTIMATE_USD : 0;
        return {
          calls: { count: myCalls.length, minutes: round(callSeconds / 60), costUsd: round(callCost) },
          sms: { count: mySms.length, costUsd: round(smsCost) },
          numberMonthlyEstimateUsd: rental,
          totalUsd: round(callCost + smsCost + rental),
        };
      };

      const clients = (auth.kind === 'client' ? [auth.client] : store.list()).map((c) => ({
        clientId: c.id,
        name: c.name,
        phoneNumber: c.phoneNumber ?? null,
        limits: c.limits,
        ...summarize(c.phoneNumber),
      }));

      if (auth.kind === 'client') {
        return { days, currency: 'USD', account: clients[0] };
      }

      const leftoverCalls = calls.filter((c) => !attributedCallSids.has(c.sid));
      const leftoverSms = messages.filter((m) => !attributedSmsSids.has(m.sid));
      const unattributed = {
        calls: {
          count: leftoverCalls.length,
          minutes: round(leftoverCalls.reduce((s, c) => s + c.durationSeconds, 0) / 60),
          costUsd: round(leftoverCalls.reduce((s, c) => s + (c.priceUsd ?? 0), 0)),
        },
        sms: {
          count: leftoverSms.length,
          costUsd: round(leftoverSms.reduce((s, m) => s + (m.priceUsd ?? 0), 0)),
        },
      };
      const totalUsd = round(
        clients.reduce((s, c) => s + c.totalUsd, 0) +
          unattributed.calls.costUsd +
          unattributed.sms.costUsd,
      );
      return { days, currency: 'USD', clients, unattributed, totalUsd };
    } catch (error) {
      return reply.code(424).send({ error: `accounting failed: ${(error as Error).message}` });
    }
  });

  // Fulfill a mid-call tool request: while the call is live the result is fed
  // straight into the conversation; after the call it records the answer and
  // clears the follow-up flag (the fulfiller then calls the person back).
  app.post('/orchestrations/:id/respond', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const record = orchestrations.get(id);
    if (!record || (auth.kind === 'client' && record.clientId !== auth.client.id)) {
      return reply.code(404).send({ error: 'no such orchestration' });
    }
    const parsed = respondBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    const request = record.pendingRequests.find((r) => r.id === parsed.data.requestId);
    if (!request) return reply.code(404).send({ error: 'no such tool request' });
    if (request.status === 'answered') {
      return reply.code(409).send({ error: 'request already answered' });
    }
    orchestrations.toolAnswered(id, request.id, parsed.data.result);
    const live = runningOrchestrators.get(id)?.provideToolResult(request.id, parsed.data.result);
    return { request, deliveredLive: live ?? false };
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
