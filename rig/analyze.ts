import { FRAME, rms } from './lib/audio';
import { AGENT_VOICE_RMS, type CallerSegment } from './caller';

const MS = 20;
/** Beep-to-beep round trip across both phone legs with no gateway in between (rig/floor.ts, 2026-11-27). */
export const PHONE_PATH_MS = 620;

export interface AgentSegment {
  startMs: number;
  endMs: number;
}

export interface GatewayRecord {
  id?: string;
  status?: string;
  reason?: string;
  turns?: { role: string; text: string }[];
  events?: string[];
  errors?: string[];
}

export interface LineResult {
  text: string;
  expect: CallerSegment['expect'];
  startMs: number;
  endMs: number;
  /** reply / bargein: ms from the caller finishing to the agent's first sound. */
  replyGapMs?: number;
  /** The agent was already making sound when the caller finished (they collided). */
  collision?: 'agent-cut-in' | 'agent-talked-through';
  noReply?: boolean;
  /** hold: the agent started talking before the caller finished their thought. */
  cutOff?: boolean;
  /** bargein: ms from the caller starting to talk until the agent fell silent. */
  stopMs?: number;
  /** bargein: the agent kept talking through the whole interruption. */
  ignored?: boolean;
  /** backchannel: the longest silence in the agent's speech around the caller's "mm-hmm" (did it falter?). */
  hesitationMs?: number;
  /** bargein / backchannel could not be tested: the agent was not talking when the line began. */
  skipped?: boolean;
}

export interface CallMetrics {
  scenario: string;
  durationMs: number;
  endedBy: string;
  greetingMs: number | null;
  lines: LineResult[];
  /** Silences over 800ms in the middle of an agent turn. */
  stalls: number[];
  /** Times the gateway cut its own speech because it thought the caller interrupted. */
  gatewayClears: number | null;
  backchannels: number;
  backchannelFalseStops: number;
  taskDone: boolean | null;
  gatewayErrors: string[];
  notes: string[];
  agentSegments: AgentSegment[];
  /**
   * How long sound took to cross the line and back on this call: what the
   * caller heard as the reply gap, minus what the gateway itself measured
   * (null when the gateway's timeline does not carry its own timings).
   */
  lineDelayMs: number | null;
}

/** A call whose line added this much more than the usual round trip is a line fault, not a gateway result. */
export const SLOW_LINE_MS = PHONE_PATH_MS + 500;

/** Where the agent is audibly speaking, from the audio the caller received. */
export function agentSegments(agent: Int16Array, joinGapMs = 200, minMs = 60): AgentSegment[] {
  const segs: AgentSegment[] = [];
  let cur: AgentSegment | null = null;
  for (let i = 0, k = 0; i + FRAME <= agent.length; i += FRAME, k++) {
    if (rms(agent, i, i + FRAME) <= AGENT_VOICE_RMS) continue;
    const t = k * MS;
    if (cur && t - cur.endMs <= joinGapMs) cur.endMs = t + MS;
    else {
      if (cur) segs.push(cur);
      cur = { startMs: t, endMs: t + MS };
    }
  }
  if (cur) segs.push(cur);
  return segs.filter((s) => s.endMs - s.startMs >= minMs);
}

export function analyzeCall(input: {
  scenario: string;
  agent: Int16Array;
  segments: CallerSegment[];
  durationMs: number;
  endedBy: string;
  notes: string[];
  success?: RegExp[];
  gateway?: GatewayRecord | null;
}): CallMetrics {
  const segs = agentSegments(input.agent);
  const lines: LineResult[] = [];
  const callerLines = input.segments;

  callerLines.forEach((line, i) => {
    const next = callerLines[i + 1];
    const windowEnd = next ? next.startMs : input.durationMs;
    const res: LineResult = { text: line.text, expect: line.expect, startMs: line.startMs, endMs: line.endMs };
    const spanning = segs.find((s) => s.startMs < line.endMs && s.endMs > line.endMs);
    const firstAfter = segs.find((s) => s.startMs >= line.endMs && s.startMs < windowEnd);

    if (line.expect === 'reply') {
      if (spanning) {
        res.collision = spanning.startMs >= line.startMs ? 'agent-cut-in' : 'agent-talked-through';
      } else if (firstAfter) {
        res.replyGapMs = firstAfter.startMs - line.endMs;
      } else if (next) {
        res.noReply = true;
      }
    } else if (line.expect === 'hold') {
      // Any agent sound that begins between the end of this fragment and the
      // end of the continuation is the agent jumping in on a mid-thought pause.
      const until = next ? next.endMs : windowEnd;
      res.cutOff = segs.some((s) => s.startMs > line.endMs - 40 && s.startMs < until);
    } else if (line.expect === 'bargein') {
      if (!line.agentTalkingAtStart) {
        res.skipped = true;
      } else {
        // The agent has "stopped" at the last sound before 500ms of quiet.
        let stopAt: number | null = null;
        const live = segs.filter((s) => s.endMs > line.startMs);
        for (let j = 0; j < live.length; j++) {
          const s = live[j]!;
          const following = live[j + 1];
          if (!following || following.startMs - s.endMs >= 500) {
            stopAt = s.endMs;
            break;
          }
        }
        if (stopAt === null || stopAt >= line.endMs) res.ignored = true;
        res.stopMs = Math.max(0, (stopAt ?? line.endMs) - line.startMs);
        const reply = segs.find((s) => s.startMs >= Math.max(line.endMs, stopAt ?? 0) && s.startMs < windowEnd);
        if (reply) res.replyGapMs = reply.startMs - line.endMs;
        else if (next) res.noReply = true;
      }
    } else if (line.expect === 'backchannel') {
      if (!line.agentTalkingAtStart) res.skipped = true;
      else {
        // Raw voiced frames (no gap-joining): any break in the agent's speech from
        // the listening noise until a second and a half after it.
        const from = Math.floor(line.startMs / MS);
        const to = Math.min(Math.floor((line.endMs + 1500) / MS), Math.floor(input.agent.length / FRAME));
        let longest = 0;
        let run = 0;
        let lastVoiced = -1;
        for (let k = from; k < to; k++) {
          if (rms(input.agent, k * FRAME, (k + 1) * FRAME) > AGENT_VOICE_RMS) {
            longest = Math.max(longest, run);
            run = 0;
            lastVoiced = k;
          } else run++;
        }
        // Silence that runs to the end of the window is the agent finishing its turn, not faltering.
        res.hesitationMs = lastVoiced < 0 ? (to - from) * MS : longest * MS;
      }
    }
    lines.push(res);
  });

  // Stalls: long silences inside one agent turn (between two caller lines).
  const stalls: number[] = [];
  const bounds = [0, ...callerLines.map((l) => l.startMs), input.durationMs];
  for (let b = 0; b + 1 < bounds.length; b++) {
    const inTurn = segs.filter((s) => s.startMs >= bounds[b]! && s.startMs < bounds[b + 1]!);
    for (let j = 0; j + 1 < inTurn.length; j++) {
      const gap = inTurn[j + 1]!.startMs - inTurn[j]!.endMs;
      if (gap > 800 && gap < 6000) stalls.push(gap);
    }
  }

  const events = input.gateway?.events;
  const gatewayClears = events ? events.filter((e) => /say\.aborted.*clear|interrupted/.test(e)).length : null;
  const backchannels = lines.filter((l) => l.expect === 'backchannel' && !l.skipped).length;
  const interruptions = lines.filter((l) => l.expect === 'bargein' && !l.skipped).length;
  // A clear is legitimate only when the caller really interrupted.
  const backchannelFalseStops =
    gatewayClears === null ? 0 : Math.min(backchannels, Math.max(0, gatewayClears > 0 && interruptions === 0 ? gatewayClears : 0));

  const agentText = (input.gateway?.turns ?? [])
    .filter((t) => t.role === 'agent')
    .map((t) => t.text)
    .join(' ');
  const taskDone = input.success && input.gateway?.turns ? input.success.every((re) => re.test(agentText)) : null;

  // The gateway logs, for each reply, how long after the caller's last sound it
  // began speaking. The difference from what the caller heard is the line.
  const mid = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  const thinks = (events ?? []).map((e) => /think=(\d+)ms/.exec(e)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  const heardGaps = lines.map((l) => l.replyGapMs).filter((v): v is number => v !== undefined);
  const lineDelayMs = thinks.length >= 2 && heardGaps.length >= 2 ? mid(heardGaps) - mid(thinks) : null;

  return {
    lineDelayMs,
    scenario: input.scenario,
    durationMs: input.durationMs,
    endedBy: input.endedBy,
    greetingMs: segs[0] && segs[0].startMs < (callerLines[0]?.startMs ?? Infinity) ? segs[0].startMs : null,
    lines,
    stalls,
    gatewayClears,
    backchannels,
    backchannelFalseStops,
    taskDone,
    gatewayErrors: input.gateway?.errors ?? [],
    notes: input.notes,
    agentSegments: segs,
  };
}

// ---------- scorecard ----------

const pct = (a: number[], p: number): number | null => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
};

const LETTERS = ['A+', 'A', 'B', 'C', 'D', 'F'] as const;
type Letter = (typeof LETTERS)[number];
const POINTS: Record<Letter, number> = { 'A+': 4.3, A: 4, B: 3, C: 2, D: 1, F: 0 };

/** Lower is better: thresholds are the upper bound for A+, A, B, C, D. */
function gradeLow(value: number | null, t: [number, number, number, number, number]): Letter | null {
  if (value === null) return null;
  for (let i = 0; i < t.length; i++) if (value <= t[i]!) return LETTERS[i]!;
  return 'F';
}
function gradeHigh(value: number | null, t: [number, number, number, number, number]): Letter | null {
  if (value === null) return null;
  for (let i = 0; i < t.length; i++) if (value >= t[i]!) return LETTERS[i]!;
  return 'F';
}

export interface ScoreRow {
  measure: string;
  value: string;
  target: string;
  grade: Letter | null;
  n: number;
}

export interface Scorecard {
  rows: ScoreRow[];
  overall: Letter;
  calls: number;
}

export function scorecard(allCalls: CallMetrics[], extra: { naturalness?: number | null; intelligibility?: number | null } = {}): Scorecard {
  // Calls where the line itself was slow (a network fault between the gateway and
  // the caller) say nothing about the gateway's timing: count them, do not time them.
  const slowLine = allCalls.filter((c) => (c.lineDelayMs ?? 0) > SLOW_LINE_MS);
  const calls = allCalls.filter((c) => !slowLine.includes(c));
  const lines = calls.flatMap((c) => c.lines);
  const replyLines = lines.filter((l) => l.expect === 'reply' || (l.expect === 'bargein' && !l.skipped));
  const gaps = replyLines.map((l) => l.replyGapMs).filter((v): v is number => v !== undefined);
  const misses = replyLines.filter((l) => l.collision || l.noReply).length;
  const holds = lines.filter((l) => l.expect === 'hold');
  const cutOffs = holds.filter((l) => l.cutOff).length;
  const barges = lines.filter((l) => l.expect === 'bargein' && !l.skipped);
  const stops = barges.map((l) => (l.ignored ? 9999 : l.stopMs!));
  const backchannels = calls.reduce((n, c) => n + c.backchannels, 0);
  const falseStops = calls.reduce((n, c) => n + c.backchannelFalseStops, 0);
  const hesitations = lines.map((l) => l.hesitationMs).filter((v): v is number => v !== undefined);
  const stallCount = calls.reduce((n, c) => n + c.stalls.length, 0);
  const tasks = calls.filter((c) => c.taskDone !== null);
  const done = tasks.filter((c) => c.taskDone).length;
  const greetings = calls.map((c) => c.greetingMs).filter((v): v is number => v !== null);
  const rate = (a: number, b: number): number | null => (b === 0 ? null : (100 * a) / b);
  const ms = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v)}ms`);
  const pc = (v: number | null): string => (v === null ? 'n/a' : `${v.toFixed(0)}%`);

  const p50 = pct(gaps, 0.5);
  const p95 = pct(gaps, 0.95);
  const stop90 = pct(stops, 0.9);
  // "As heard" numbers include the phone path itself (PHONE_PATH_MS round trip
  // in this rig, measured by rig/floor.ts): the gateway's own share is the rest.
  const own = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v)}ms (gateway ~${Math.max(0, Math.round(v - PHONE_PATH_MS))}ms)`);
  const rows: ScoreRow[] = [
    { measure: 'Reply gap as heard, median', value: own(p50), target: '<= 1000ms', grade: gradeLow(p50, [1000, 1200, 1500, 2000, 2800]), n: gaps.length },
    { measure: 'Reply gap as heard, 95th pct', value: own(p95), target: '<= 1500ms', grade: gradeLow(p95, [1500, 1800, 2300, 3000, 4000]), n: gaps.length },
    { measure: 'Collisions / no reply', value: pc(rate(misses, replyLines.length)), target: '0%', grade: gradeLow(rate(misses, replyLines.length), [0, 5, 10, 20, 35]), n: replyLines.length },
    { measure: 'Stops when interrupted (90th pct)', value: stop90 === 9999 ? 'ignored' : own(stop90), target: '<= 900ms', grade: gradeLow(stop90, [900, 1100, 1400, 1900, 2600]), n: stops.length },
    { measure: 'Cut-offs on mid-sentence pauses', value: pc(rate(cutOffs, holds.length)), target: '0%', grade: gradeLow(rate(cutOffs, holds.length), [0, 5, 10, 20, 35]), n: holds.length },
    { measure: 'False stops on "mm-hmm"', value: pc(rate(falseStops, backchannels)), target: '0%', grade: gradeLow(rate(falseStops, backchannels), [0, 5, 10, 20, 35]), n: backchannels },
    { measure: 'Pause in speech on "mm-hmm", median', value: ms(pct(hesitations, 0.5)), target: '<= 250ms', grade: gradeLow(pct(hesitations, 0.5), [250, 400, 600, 800, 1200]), n: hesitations.length },
    { measure: 'Stalls mid-reply (per call)', value: calls.length ? (stallCount / calls.length).toFixed(2) : 'n/a', target: '0', grade: gradeLow(calls.length ? stallCount / calls.length : null, [0, 0.1, 0.3, 0.6, 1]), n: calls.length },
    { measure: 'Pickup to greeting, median', value: ms(pct(greetings, 0.5)), target: '<= 1000ms', grade: gradeLow(pct(greetings, 0.5), [1000, 1400, 2000, 3000, 4500]), n: greetings.length },
    { measure: 'Task completed', value: pc(rate(done, tasks.length)), target: '100%', grade: gradeHigh(rate(done, tasks.length), [100, 95, 90, 80, 65]), n: tasks.length },
  ];
  if (extra.intelligibility !== undefined) {
    rows.push({ measure: 'Agent words heard correctly', value: pc(extra.intelligibility), target: '>= 98%', grade: gradeHigh(extra.intelligibility, [98, 96, 93, 88, 80]), n: calls.length });
  }
  if (extra.naturalness !== undefined) {
    rows.push({ measure: 'Naturalness (listener rating /5)', value: extra.naturalness === null ? 'n/a' : extra.naturalness.toFixed(2), target: '>= 4.5', grade: gradeHigh(extra.naturalness, [4.5, 4.2, 3.7, 3.2, 2.5]), n: calls.length });
  }

  if (slowLine.length > 0) {
    const worst = Math.max(...slowLine.map((c) => c.lineDelayMs ?? 0));
    rows.push({
      measure: 'Calls left out: the line itself was slow',
      value: `${slowLine.length} of ${allCalls.length} (line added up to ${Math.round(worst)}ms; normal ${PHONE_PATH_MS}ms)`,
      target: '-',
      grade: null,
      n: slowLine.length,
    });
  }
  const graded = rows.filter((r) => r.grade !== null);
  const avg = graded.reduce((s, r) => s + POINTS[r.grade!], 0) / Math.max(1, graded.length);
  let idx = avg >= 4.25 ? 0 : avg >= 3.7 ? 1 : avg >= 2.7 ? 2 : avg >= 1.7 ? 3 : avg >= 0.8 ? 4 : 5;
  // One weak area sinks a phone call: overall is at most one letter above the worst measure.
  const worst = Math.max(...graded.map((r) => LETTERS.indexOf(r.grade!)));
  idx = Math.max(idx, worst - 1);
  // A+ overall means A+ everywhere.
  if (idx === 0 && worst > 0) idx = 1;
  return { rows, overall: LETTERS[idx]!, calls: allCalls.length };
}

export function renderScorecard(card: Scorecard, title: string): string {
  const out = [`# ${title}`, '', `Overall: **${card.overall}** (${card.calls} calls)`, '', '| Measure | Result | A+ target | Grade | Samples |', '|---|---|---|---|---|'];
  for (const r of card.rows) out.push(`| ${r.measure} | ${r.value} | ${r.target} | ${r.grade ?? '-'} | ${r.n} |`);
  return out.join('\n') + '\n';
}
