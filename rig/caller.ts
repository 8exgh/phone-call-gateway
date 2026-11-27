import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { decode as mulawDecode, encode as mulawEncode } from '../src/audio/mulaw';
import { fromBase64, toBase64 } from '../src/audio/frames';
import { FRAME, concat, rms } from './lib/audio';
import { getClip } from './lib/clips';
import { endCall } from './lib/twilio';
import type { Expect, Scenario, Step } from './scenarios';

/** Agent audio louder than this (RMS over a 20ms frame) counts as the agent's voice. */
export const AGENT_VOICE_RMS = 180;
const MS = 20;

export interface CallerSegment {
  text: string;
  expect: Expect;
  startMs: number;
  endMs: number;
  /** Was the agent audibly talking when this line began? */
  agentTalkingAtStart: boolean;
}

export interface CallArtifact {
  sessionId: string;
  scenario: string;
  callSid: string | null;
  caller: Int16Array;
  agent: Int16Array;
  segments: CallerSegment[];
  notes: string[];
  endedBy: 'caller' | 'agent' | 'timeout';
  durationMs: number;
}

/**
 * One robot caller: plays the scenario into a call and records both sides on
 * one clock. Transport-agnostic: feed it each 20ms of agent audio with tick()
 * and send back what it returns. attach() wires it to a Twilio media stream;
 * the local simulator drives tick() directly.
 */
export class CallerSession {
  callSid: string | null = null;
  /** Called when the script decides to hang up (default: end the Twilio call). */
  onHangup: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private streamSid: string | null = null;
  private tick = 0;
  private readonly agentFrames: Int16Array[] = [];
  private readonly callerFrames: Int16Array[] = [];
  private readonly segments: CallerSegment[] = [];
  private readonly notes: string[] = [];

  private stepIndex = 0;
  private stepStartTick = 0;
  private playing: { pcm: Int16Array; offset: number; seg: CallerSegment } | null = null;
  private clips = new Map<string, Int16Array>();

  // live view of the agent's side
  private voicedRun = 0;
  private lastVoicedTick = -1e9;
  private agentTalking = false;
  private talkingSinceTick = 0;
  private voicedSinceStepMs = 0;

  private hungUp = false;
  private done = false;
  private resolveDone!: (a: CallArtifact) => void;
  readonly finished: Promise<CallArtifact>;
  private noiseState = 0;

  constructor(
    readonly sessionId: string,
    readonly scenario: Scenario,
  ) {
    this.finished = new Promise((resolve) => (this.resolveDone = resolve));
  }

  async prepare(): Promise<void> {
    for (const step of this.scenario.steps) {
      if ('say' in step) this.clips.set(step.say, await getClip(step.say, step.style ?? this.scenario.style ?? 'natural'));
    }
  }

  attach(ws: WebSocket): void {
    this.ws = ws;
    ws.on('message', (data: Buffer | string) => this.onMessage(data.toString()));
    ws.on('close', () => this.finish(this.hungUp ? 'caller' : 'agent'));
  }

  /** Give up on a call that never connected or never ended. */
  abort(reason: string): void {
    this.notes.push(reason);
    if (this.callSid) void endCall(this.callSid);
    this.finish('timeout');
  }

  private onMessage(raw: string): void {
    let msg: { event?: string; start?: { streamSid?: string; callSid?: string }; media?: { payload?: string; track?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event === 'start') {
      this.streamSid = msg.start?.streamSid ?? null;
      if (msg.start?.callSid && !this.callSid) this.callSid = msg.start.callSid;
    } else if (msg.event === 'media' && typeof msg.media?.payload === 'string') {
      this.onAgentFrame(mulawDecode(fromBase64(msg.media.payload)));
    } else if (msg.event === 'stop') {
      this.finish(this.hungUp ? 'caller' : 'agent');
    }
  }

  private onAgentFrame(pcm: Int16Array): void {
    const out = this.step(pcm);
    if (this.ws && this.streamSid && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(
        JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: toBase64(mulawEncode(out)) } }),
      );
    }
  }

  /** Advance one 20ms tick: take what the agent side sounded like, return what the caller says. */
  step(pcm: Int16Array): Int16Array {
    this.agentFrames.push(pcm);
    const voiced = rms(pcm) > AGENT_VOICE_RMS;
    if (voiced) {
      this.voicedRun++;
      this.lastVoicedTick = this.tick;
      this.voicedSinceStepMs += MS;
      if (!this.agentTalking && this.voicedRun >= 3) {
        this.agentTalking = true;
        this.talkingSinceTick = this.tick - 2;
      }
    } else {
      this.voicedRun = 0;
      if (this.agentTalking && this.quietMs() >= 300) this.agentTalking = false;
    }

    const out = this.nextCallerFrame();
    this.callerFrames.push(out);
    this.tick++;
    return out;
  }

  get isDone(): boolean {
    return this.done;
  }

  get hasHungUp(): boolean {
    return this.hungUp;
  }

  /** The call is over (transport closed, or the simulator saw a hangup). */
  end(endedBy: CallArtifact['endedBy']): void {
    this.finish(endedBy);
  }

  private quietMs(): number {
    return (this.tick - this.lastVoicedTick) * MS;
  }

  private advance(): void {
    this.stepIndex++;
    this.stepStartTick = this.tick;
    this.voicedSinceStepMs = 0;
  }

  private nextCallerFrame(): Int16Array {
    const frame = new Int16Array(FRAME);
    for (let guard = 0; guard < 50; guard++) {
      if (this.playing) {
        const { pcm, offset, seg } = this.playing;
        const take = Math.min(FRAME, pcm.length - offset);
        frame.set(pcm.subarray(offset, offset + take));
        this.playing.offset += take;
        if (this.playing.offset >= pcm.length) {
          seg.endMs = (this.tick + 1) * MS;
          this.playing = null;
          this.advance();
        }
        break;
      }
      const step: Step | undefined = this.scenario.steps[this.stepIndex];
      if (!step) {
        this.hangup();
        break;
      }
      const waitedMs = (this.tick - this.stepStartTick) * MS;
      if ('say' in step) {
        const seg: CallerSegment = {
          text: step.say,
          expect: step.expect,
          startMs: this.tick * MS,
          endMs: this.tick * MS,
          agentTalkingAtStart: this.agentTalking,
        };
        this.segments.push(seg);
        this.playing = { pcm: this.clips.get(step.say)!, offset: 0, seg };
        continue;
      }
      if ('pause' in step) {
        if (waitedMs >= step.pause) {
          this.advance();
          continue;
        }
        break;
      }
      if ('waitAgentTurn' in step) {
        const quietFor = step.quietMs ?? 700;
        if (this.voicedSinceStepMs >= 200 && this.quietMs() >= quietFor) {
          this.advance();
          continue;
        }
        if (waitedMs >= (step.timeoutMs ?? 20_000)) {
          this.notes.push(`step ${this.stepIndex}: agent turn never came (${waitedMs}ms)`);
          this.advance();
          continue;
        }
        break;
      }
      if ('waitAgentTalking' in step) {
        if (this.agentTalking && (this.tick - this.talkingSinceTick) * MS >= step.waitAgentTalking) {
          this.advance();
          continue;
        }
        if (waitedMs >= (step.timeoutMs ?? 20_000)) {
          this.notes.push(`step ${this.stepIndex}: agent never talked long enough to talk over (${waitedMs}ms)`);
          this.advance();
          continue;
        }
        break;
      }
      this.hangup();
      break;
    }
    const noise = this.scenario.noiseRms ?? 0;
    if (noise > 0) {
      // Low-passed white noise: a steady room/road hum under the caller's voice.
      for (let i = 0; i < FRAME; i++) {
        this.noiseState = 0.85 * this.noiseState + 0.15 * (Math.random() * 2 - 1);
        const v = frame[i]! + this.noiseState * noise * 4.2;
        frame[i] = Math.max(-32768, Math.min(32767, v));
      }
    }
    return frame;
  }

  private hangup(): void {
    if (this.hungUp) return;
    this.hungUp = true;
    if (this.onHangup) this.onHangup();
    else if (this.callSid) void endCall(this.callSid);
  }

  private finish(endedBy: CallArtifact['endedBy']): void {
    if (this.done) return;
    this.done = true;
    if (this.playing) this.playing.seg.endMs = this.tick * MS;
    this.resolveDone({
      sessionId: this.sessionId,
      scenario: this.scenario.name,
      callSid: this.callSid,
      caller: concat(this.callerFrames),
      agent: concat(this.agentFrames),
      segments: this.segments,
      notes: this.notes,
      endedBy,
      durationMs: this.tick * MS,
    });
    try {
      this.ws?.close();
    } catch {
      /* closed */
    }
  }
}

/** HTTP + WebSocket endpoint Twilio connects the robot caller's leg to. */
export async function startCallerServer(port: number): Promise<{
  sessions: Map<string, CallerSession>;
  close: () => Promise<void>;
}> {
  const sessions = new Map<string, CallerSession>();
  const app = Fastify();
  await app.register(websocket);
  app.get('/rig/health', async () => ({ ok: true, rig: 'caller' }));
  app.register(async (instance) => {
    instance.get('/rig/media/:sessionId', { websocket: true }, (socket, req) => {
      const { sessionId } = req.params as { sessionId: string };
      const session = sessions.get(sessionId);
      if (!session) {
        socket.close();
        return;
      }
      session.attach(socket as unknown as WebSocket);
    });
  });
  await app.listen({ port, host: '127.0.0.1' });
  return { sessions, close: () => app.close() };
}
