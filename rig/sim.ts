import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode as mulawDecode, encode as mulawEncode, MULAW_SILENCE } from '../src/audio/mulaw';
import { RealtimeAgent, type TurnTuning } from '../src/realtime/realtimeAgent';
import { openAiRealtimeSocketFactory } from '../src/realtime/realtimeSocket';
import { elevenLabsTtsFactory } from '../src/speech/elevenLabsTts';
import { openAiWordSpotterFactory } from '../src/realtime/wordSpotter';
import type { CallSession, MediaTap } from '../src/call/callSession';
import { DEFAULT_TOOLS } from '../src/server';
import { CallerSession } from './caller';
import { PERSONA, SCENARIOS, type Scenario } from './scenarios';
import { analyzeCall, renderScorecard, scorecard, type CallMetrics } from './analyze';
import { writeWavStereo } from './lib/audio';

dotenv({ path: join(__dirname, '..', '.env'), override: true });

/**
 * Local simulator: the real voice agent and the real robot-caller scripts,
 * joined in-process with a simulated phone path (a fixed delay each way)
 * instead of Twilio. Scenarios run in parallel, so a full pass takes about a
 * minute and costs no phone time. The phone rig (run.ts) stays the ground
 * truth; this is for fast iteration on turn-taking.
 *
 *   node --import tsx rig/sim.ts --label try --n 2 [--scenario pauses,bargein] [--delay 310]
 *   env: REALTIME_MODEL, REALTIME_REASONING, REALTIME_VOICE, VOICE_TUNING, SIM_GOAL, SIM_OPENING
 */
const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'sim' },
    n: { type: 'string', default: '1' },
    scenario: { type: 'string', default: 'all' },
    /** One-way delay of the simulated phone path, ms (the real rig measures ~310 each way). */
    delay: { type: 'string', default: '310' },
    /** Calls in flight at once (too many at once slows the model and distorts timings). */
    parallel: { type: 'string', default: '4' },
    /** Fraction of the agent's own voice that comes back down the line as echo (speakerphone ~0.1-0.2). */
    echo: { type: 'string', default: '0' },
  },
});

const MODEL = process.env.REALTIME_MODEL ?? 'gpt-realtime-1.5';
const EFFORT = process.env.REALTIME_REASONING || undefined;
const VOICE = process.env.REALTIME_VOICE ?? 'marin';
const TUNING = process.env.VOICE_TUNING ? (JSON.parse(process.env.VOICE_TUNING) as Partial<TurnTuning>) : undefined;
/** REALTIME_VOICE=elevenlabs:<voice_id> speaks with that ElevenLabs voice. */
function outsideVoice(): { stream: ReturnType<ReturnType<typeof elevenLabsTtsFactory>>; key: string } | undefined {
  const match = /^elevenlabs:(.+)$/.exec(VOICE);
  if (!match) return undefined;
  return { stream: elevenLabsTtsFactory({ apiKey: process.env.ELEVENLABS_API_KEY! })(match[1]!), key: VOICE };
}

const DELAY_FRAMES = Math.round(Number(values.delay) / 20);
const SILENT = new Uint8Array(160).fill(MULAW_SILENCE);
const ECHO = Number(values.echo);
const allEvents: string[] = [];

/** Stands in for Twilio + CallSession: a playout buffer, marks, clear, and a delay line each way. */
class SimLine {
  tap: MediaTap | null = null;
  private playout: (Uint8Array | { mark: string })[] = [];
  private toCaller: Uint8Array[] = [];
  private toAgent: Uint8Array[] = [];
  private pendingMarks: { name: string; atTick: number }[] = [];
  hungUp = false;
  private tickNo = 0;

  asSession(): CallSession {
    return {
      attachTap: (tap: MediaTap) => {
        this.tap = tap;
      },
      tapWrite: (frame: Uint8Array) => {
        this.playout.push(frame);
      },
      tapMark: (name: string) => {
        this.playout.push({ mark: name });
      },
      tapClear: () => {
        // Twilio drops unplayed audio and returns outstanding marks at once.
        for (const item of this.playout) if (!(item instanceof Uint8Array)) this.pendingMarks.push({ name: item.mark, atTick: this.tickNo });
        this.playout = [];
      },
      hangup: async () => {
        this.hungUp = true;
      },
    } as unknown as CallSession;
  }

  /** One 20ms tick. Takes the caller's frame, returns what the caller hears. */
  tick(callerFrame: Uint8Array): Uint8Array {
    this.tickNo++;
    // agent -> caller: what Twilio plays now reaches the caller's ear after the delay
    let playing: Uint8Array = SILENT;
    while (this.playout.length > 0) {
      const head = this.playout.shift()!;
      if (head instanceof Uint8Array) {
        playing = head;
        break;
      }
      this.pendingMarks.push({ name: head.mark, atTick: this.tickNo });
    }
    this.toCaller.push(playing);
    const heard = this.toCaller.length > DELAY_FRAMES ? this.toCaller.shift()! : SILENT;
    // marks travel back to the gateway (half the path)
    while (this.pendingMarks.length > 0 && this.tickNo - this.pendingMarks[0]!.atTick >= Math.round(DELAY_FRAMES / 2)) {
      this.tap?.onMark(this.pendingMarks.shift()!.name);
    }
    // caller -> agent, with whatever of the agent's own voice leaks back into the caller's microphone
    let outbound = callerFrame;
    if (ECHO > 0 && heard !== SILENT) {
      const mic = mulawDecode(callerFrame);
      const leak = mulawDecode(heard);
      const mixed = new Int16Array(mic.length);
      for (let i = 0; i < mic.length; i++) mixed[i] = Math.max(-32768, Math.min(32767, mic[i]! + ECHO * leak[i]!));
      outbound = mulawEncode(mixed);
    }
    this.toAgent.push(outbound);
    if (this.toAgent.length > DELAY_FRAMES) this.tap?.onFrame(this.toAgent.shift()!);
    return heard;
  }
}

async function runOne(scenario: Scenario, tag: string, outDir: string | null): Promise<CallMetrics> {
  const line = new SimLine();
  const caller = new CallerSession(tag, scenario);
  await caller.prepare();
  const events: string[] = [];
  const errors: string[] = [];
  const startedAt = Date.now();
  const agent = new RealtimeAgent({
    session: line.asSession(),
    socketFactory: openAiRealtimeSocketFactory(process.env.OPENAI_API_KEY!),
    model: MODEL,
    reasoningEffort: EFFORT,
    defaultVoice: VOICE,
    voice: VOICE,
    tts: outsideVoice(),
    wordSpotter: process.env.WORD_SPOTTER === '0' ? undefined : openAiWordSpotterFactory(process.env.OPENAI_API_KEY!)(),
    language: 'en',
    tuning: TUNING,
    // SIM_GOAL / SIM_OPENING stand in for an outbound call's goal and first line.
    systemPrompt: process.env.SIM_GOAL ? `Your goal for this call: ${process.env.SIM_GOAL}` : `You are ANSWERING an incoming call from +15878175749. ${PERSONA.goal}`,
    objective: process.env.SIM_GOAL ?? PERSONA.goal,
    openingLine: process.env.SIM_OPENING ?? PERSONA.openingLine,
    tools: DEFAULT_TOOLS,
    turnTimeoutMs: 15_000,
    onTimeline: (text) => events.push(`${Date.now() - startedAt}ms ${text}`),
    onError: (message) => errors.push(message),
    onLlmError: (message) => errors.push(`llm_failed: ${message}`),
  });
  const result = agent.run();
  let callerHungUp = false;
  caller.onHangup = () => {
    callerHungUp = true;
  };
  // The call "connects" half a second after it is placed, as on the phone.
  await new Promise((r) => setTimeout(r, 500));
  line.tap?.onStart();

  const encode = mulawEncode;
  let k = 0;
  const t0 = Date.now();
  let callerFrame: Uint8Array = encode(caller.step(mulawDecode(SILENT)));
  for (;;) {
    const heard = line.tick(callerFrame);
    callerFrame = encode(caller.step(mulawDecode(heard)));
    k++;
    if (line.hungUp || callerHungUp || k > 170 * 50) break;
    const wait = t0 + k * 20 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const endedBy = line.hungUp ? 'agent' : callerHungUp ? 'caller' : 'timeout';
  line.tap?.onClosed('ended', line.hungUp ? 'hangup' : 'remote_hangup');
  const call = await result;
  const done = new Promise<Awaited<typeof caller.finished>>((r) => void caller.finished.then(r));
  caller.end(endedBy);
  const art = await done;
  const gateway = { status: call.finalState, reason: call.reason, turns: call.turns, events, errors };
  allEvents.push(...events);
  const metrics = analyzeCall({
    scenario: scenario.name,
    agent: art.agent,
    segments: art.segments,
    durationMs: art.durationMs,
    endedBy,
    notes: art.notes,
    success: scenario.success,
    gateway,
  });
  if (outDir) {
    writeWavStereo(join(outDir, `${tag}.wav`), art.caller, art.agent);
    writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ tag, segments: art.segments, metrics, gateway }, null, 2));
  }
  const gaps = metrics.lines.map((l) => l.replyGapMs).filter((v) => v !== undefined);
  const flags = metrics.lines
    .map((l) => l.collision ?? (l.noReply ? 'no-reply' : l.cutOff ? 'cut-off' : l.ignored ? 'ignored-interrupt' : l.skipped ? 'skipped' : l.stopMs !== undefined ? `stop${l.stopMs}` : null))
    .filter(Boolean);
  console.log(
    `${tag.padEnd(14)} ${String(Math.round(art.durationMs / 1000)).padStart(3)}s ended-by=${endedBy} gaps=[${gaps.join(',')}]` +
      `${flags.length ? ` flags=[${flags.join(',')}]` : ''} stalls=${metrics.stalls.length} clears=${metrics.gatewayClears} task=${metrics.taskDone}` +
      `${art.notes.length ? ` notes=${JSON.stringify(art.notes)}` : ''}${errors.length ? ` errors=${JSON.stringify(errors).slice(0, 300)}` : ''}`,
  );
  return metrics;
}

async function main(): Promise<void> {
  const wanted = values.scenario === 'all' ? SCENARIOS.filter((s) => !s.optIn) : SCENARIOS.filter((s) => values.scenario!.split(',').includes(s.name));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(__dirname, 'out', `${stamp}-sim-${values.label}`);
  mkdirSync(outDir, { recursive: true });
  const queue: { scenario: Scenario; tag: string }[] = [];
  for (let round = 0; round < Number(values.n); round++) {
    for (const scenario of wanted) queue.push({ scenario, tag: `${scenario.name}-${round + 1}` });
  }
  const all: CallMetrics[] = [];
  const workers = Array.from({ length: Math.min(Number(values.parallel), queue.length) }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      all.push(await runOne(job.scenario, job.tag, outDir));
    }
  });
  await Promise.all(workers);
  // How long the model itself took, and the total think time, across every reply.
  const model: number[] = [];
  const think: number[] = [];
  for (const line of allEvents) {
    const m = /think=(\d+)ms \(model answered in (\d+)ms/.exec(line);
    if (m) {
      think.push(Number(m[1]));
      model.push(Number(m[2]));
    }
  }
  const q = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;
  console.log(`\nmodel time p50 ${q(model, 0.5)}ms p90 ${q(model, 0.9)}ms | gateway think p50 ${q(think, 0.5)}ms p90 ${q(think, 0.9)}ms (${think.length} replies)`);
  const text = renderScorecard(scorecard(all), `Simulated: ${values.label} (${MODEL}${EFFORT ? ` ${EFFORT}` : ''}, phone path ${DELAY_FRAMES * 40}ms round trip)`);
  writeFileSync(join(outDir, 'scorecard.md'), text);
  console.log(`\n${text}\nartifacts: ${outDir}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
