import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallerSession, startCallerServer } from './caller';
import { PERSONA, SCENARIOS } from './scenarios';
import { analyzeCall, renderScorecard, scorecard, type CallMetrics, type GatewayRecord } from './analyze';
import { writeWavStereo } from './lib/audio';
import { createCall } from './lib/twilio';

// The shell may export a stale key; the project's .env is authoritative for the rig.
dotenv({ path: join(__dirname, '..', '.env'), override: true });
dotenv({ path: join(__dirname, '.state', 'session.env'), override: true });

/**
 * Run the robot-caller scenarios against the local gateway over real phone
 * calls and print a graded scorecard.
 *
 *   npx tsx rig/run.ts --label baseline --n 3 [--scenario booking,quick]
 *
 * Against a deployed gateway: `rig/session.sh caller` (robot caller only), point the agent
 * test number's voice webhook at that gateway, and set RIG_GATEWAY_LOCAL to its URL and
 * RIG_GATEWAY_TOKEN to the key of a client that owns the agent test number.
 */
const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'run' },
    n: { type: 'string', default: '1' },
    scenario: { type: 'string', default: 'all' },
    voice: { type: 'string' },
  },
});

const GATEWAY = process.env.RIG_GATEWAY_LOCAL ?? 'http://127.0.0.1:3310';
/** Bearer token when the gateway under test requires one (a deployed gateway: use a client key). */
const TOKEN = process.env.RIG_GATEWAY_TOKEN;
const CALLER_PUBLIC = process.env.RIG_CALLER_PUBLIC!;
const AGENT_NUMBER = process.env.RIG_AGENT_NUMBER!;
const CALLER_NUMBER = process.env.RIG_CALLER_NUMBER!;
const CALLER_PORT = Number(process.env.RIG_CALLER_PORT ?? 3311);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function gw(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`gateway ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

async function inboundIds(): Promise<string[]> {
  const list = (await gw('/orchestrations?direction=inbound')) as { orchestrations?: { id: string }[] };
  return (list.orchestrations ?? []).map((o) => o.id);
}

async function main(): Promise<void> {
  if (!CALLER_PUBLIC || !AGENT_NUMBER || !CALLER_NUMBER) throw new Error('rig session not up: run rig/session.sh up');
  const wanted = values.scenario === 'all' ? SCENARIOS : SCENARIOS.filter((s) => values.scenario!.split(',').includes(s.name));
  const n = Number(values.n);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(__dirname, 'out', `${stamp}-${values.label}`);
  mkdirSync(outDir, { recursive: true });

  await gw('/health');
  await gw('/inbound-config', {
    method: 'POST',
    body: JSON.stringify({ ...PERSONA, ...(values.voice ? { voice: values.voice } : {}) }),
  });

  const server = await startCallerServer(CALLER_PORT);
  // The public hostname must reach this process before Twilio is pointed at it.
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${CALLER_PUBLIC}/rig/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) break;
    } catch {
      /* tunnel still warming up */
    }
    if (i > 40) throw new Error(`caller tunnel ${CALLER_PUBLIC} never became reachable`);
    await sleep(3000);
  }

  const all: CallMetrics[] = [];
  const wssBase = CALLER_PUBLIC.replace(/^http/, 'ws');
  for (let round = 0; round < n; round++) {
    for (const scenario of wanted) {
      const tag = `${scenario.name}-${round + 1}`;
      const sessionId = randomUUID();
      const session = new CallerSession(sessionId, scenario);
      await session.prepare();
      server.sessions.set(sessionId, session);
      const before = new Set(await inboundIds());
      try {
        session.callSid = await createCall({
          to: AGENT_NUMBER,
          from: CALLER_NUMBER,
          twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wssBase}/rig/media/${sessionId}" /></Connect></Response>`,
          timeLimitSec: 150,
        });
      } catch (error) {
        console.error(`! ${tag}: could not place call: ${(error as Error).message}`);
        continue;
      }
      const watchdog = setTimeout(() => session.abort('rig watchdog: call exceeded 170s'), 170_000);
      const art = await session.finished;
      clearTimeout(watchdog);
      server.sessions.delete(sessionId);

      // The gateway's own account of the call (turn text, event timeline).
      let record: GatewayRecord | null = null;
      for (let i = 0; i < 20 && !record; i++) {
        const fresh = (await inboundIds()).filter((id) => !before.has(id));
        if (fresh.length > 0) {
          const r = (await gw(`/orchestrations/${fresh[0]}`)) as GatewayRecord;
          if (r.status === 'ended' || r.status === 'failed') record = r;
        }
        if (!record) await sleep(500);
      }

      const metrics = analyzeCall({
        scenario: scenario.name,
        agent: art.agent,
        segments: art.segments,
        durationMs: art.durationMs,
        endedBy: art.endedBy,
        notes: art.notes,
        success: scenario.success,
        gateway: record,
      });
      all.push(metrics);
      writeWavStereo(join(outDir, `${tag}.wav`), art.caller, art.agent);
      writeFileSync(
        join(outDir, `${tag}.json`),
        JSON.stringify({ tag, callSid: art.callSid, segments: art.segments, metrics, gateway: record }, null, 2),
      );
      const gaps = metrics.lines.map((l) => l.replyGapMs).filter((v) => v !== undefined);
      const flags = metrics.lines
        .map((l) => l.collision ?? (l.noReply ? 'no-reply' : l.cutOff ? 'cut-off' : l.ignored ? 'ignored-interrupt' : l.skipped ? 'skipped' : null))
        .filter(Boolean);
      console.log(
        `${tag.padEnd(14)} ${String(Math.round(art.durationMs / 1000)).padStart(3)}s ended-by=${art.endedBy} gaps=[${gaps.join(',')}]` +
          `${flags.length ? ` flags=[${flags.join(',')}]` : ''} stalls=${metrics.stalls.length} clears=${metrics.gatewayClears ?? '?'} task=${metrics.taskDone}` +
          `${art.notes.length ? ` notes=${JSON.stringify(art.notes)}` : ''}${metrics.gatewayErrors.length ? ` errors=${JSON.stringify(metrics.gatewayErrors)}` : ''}`,
      );
      await sleep(1500);
    }
  }

  const card = scorecard(all);
  const text = renderScorecard(card, `Scorecard: ${values.label}`);
  writeFileSync(join(outDir, 'scorecard.md'), text);
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ label: values.label, card, calls: all }, null, 2));
  console.log(`\n${text}\nartifacts: ${outDir}`);
  await server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
