import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CallRegistry } from './call/callRegistry';
import { CallSession } from './call/callSession';
import { handleControlConnection } from './call/controlSocket';
import type { SpeechSynthesizer } from './speech/synthesizer';
import type { TranscriberFactory } from './speech/transcriber';
import type { PurchasedNumber, TwilioApi } from './telephony/twilioApi';

export interface ServerDeps {
  twilioApi: TwilioApi;
  synthesizer: SpeechSynthesizer;
  transcriberFactory: TranscriberFactory;
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
        .code(502)
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

  app.post('/calls', async (req, reply) => {
    const parsed = callsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
    }
    let from = parsed.data.from ?? ownedNumbers.at(-1)?.phoneNumber ?? config.twilioFromNumber;
    if (!from) {
      // The gateway may have restarted since the number was purchased; the
      // provider still knows what we own.
      from = (await deps.twilioApi.listOwnedNumbers())[0]?.phoneNumber;
    }
    if (!from) {
      return reply
        .code(400)
        .send({ error: 'no from number: register one via POST /numbers or set TWILIO_FROM_NUMBER' });
    }

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
        to: parsed.data.to,
        from,
        streamUrl: `${wsBase()}/twilio/media/${callId}`,
      });
      session.setDialing(created.providerCallSid);
    } catch (error) {
      session.fail(`create_call_failed: ${(error as Error).message}`);
      return reply.code(502).send({ error: (error as Error).message, callId });
    }

    return { callId, to: parsed.data.to, from, controlUrl: `/control/${callId}` };
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
