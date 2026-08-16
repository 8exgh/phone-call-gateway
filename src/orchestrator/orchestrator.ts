import WebSocket from 'ws';
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type TranscriptMessage,
} from '../protocol/messages';
import type { ChatClient, ChatMessage, ToolCallRequest, ToolDef } from './chatClient';

/** When the LLM's reply contains this marker, the call is ended after speaking. */
export const HANGUP_MARKER = 'HANGUP';

export interface OrchestratorOptions {
  /** ws:// URL of the gateway's control socket for the call. */
  controlUrl: string;
  chatClient: ChatClient;
  /** Persona and goal for the call. */
  systemPrompt: string;
  /** One-line objective, restated to the model on every turn to prevent drift. */
  objective?: string;
  /** Fixed opening line; when omitted the LLM is asked to open the call. */
  openingLine?: string;
  voice?: string;
  /** Tools the model may invoke mid-call; fulfilled externally via provideToolResult. */
  tools?: ToolDef[];
  /** ms to hold the line waiting for a tool result before promising a callback. */
  toolTimeoutMs?: number;
  /** Fired when the model invokes a tool: surface it to whoever fulfills it. */
  onToolRequest?: (request: ToolCallRequest) => void;
  /** Fired when tool results didn't arrive in time and a callback was promised. */
  onToolTimeout?: (requestIds: string[]) => void;
  /** ms of caller silence (after our say completes) before re-engaging; 0 disables. */
  turnTimeoutMs?: number;
  /** ms to wait after the last keypress before handing the digits to the LLM. */
  dtmfFlushMs?: number;
  /** Observer for every server event (used by the CLI for live printing). */
  onEvent?: (event: ServerMessage) => void;
}

export interface ConversationTurn {
  role: 'agent' | 'caller';
  text: string;
  /** Prosody annotation for caller turns, e.g. "[volume: loud, pace: fast, stuttering]". */
  annotation?: string;
}

export interface CallResult {
  finalState: 'ended' | 'failed';
  reason?: string;
  turns: ConversationTurn[];
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * True when a caller transcript is (mostly) a copy of something the agent just
 * said: residual line echo that slipped past the audio-level gate. Feeding it
 * to the LLM would make the agent answer itself.
 */
export function isEchoOfAgent(callerText: string, recentAgentTexts: string[]): boolean {
  const callerWords = normalizeWords(callerText);
  if (callerWords.length === 0) return true;
  const agentWords = new Set(recentAgentTexts.flatMap(normalizeWords));
  if (agentWords.size === 0) return false;
  const contained = callerWords.filter((w) => agentWords.has(w)).length;
  return contained / callerWords.length >= 0.8 && callerWords.length >= 3;
}

export function formatProsody(t: TranscriptMessage): string {
  const parts = [`volume: ${t.volume.class}`, `pace: ${t.pace.class}`];
  if (t.stutter.detected) parts.push('stuttering');
  return `[${parts.join(', ')}]`;
}

/** Derive TTS style instructions from how the caller last spoke. */
export function deriveTtsInstructions(t: TranscriptMessage | null): string | undefined {
  if (!t) return undefined;
  const parts: string[] = [];
  if (t.volume.class === 'yell' || t.volume.class === 'loud') {
    parts.push('Stay calm, warm, and de-escalating.');
  }
  if (t.volume.class === 'whisper') parts.push('Speak gently and quietly.');
  if (t.stutter.detected) parts.push('Speak slowly and reassuringly.');
  if (t.pace.class === 'fast') parts.push('Keep a measured, unhurried pace.');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

const SYSTEM_SUFFIX = `

You are speaking on a live phone call. Reply with exactly what you will say out loud: short,
natural sentences, at most two per reply. No stage directions, no markdown, no surrounding
quotation marks.

Be relentlessly goal-oriented:
- Every reply must move the call toward the objective. Keep track of what you still need.
- If the conversation drifts, acknowledge in a few words and steer straight back.
- Ask for exactly one thing at a time. Read important details back (names, dates, numbers).
- The moment the objective is achieved — or clearly cannot be — confirm the outcome in one
  sentence and include ${HANGUP_MARKER}. Never linger or make small talk.

When you need information or an action you don't have at hand (a calendar, a lookup, a
computation, the web, a file), call one of your tools instead of guessing or stalling.
While a tool runs, hold the line naturally; if its result cannot arrive during the call,
tell the caller you will take care of it right now and call them back immediately, then
include ${HANGUP_MARKER}.

To press phone keypad keys (IVR menus: "press 1 for..."), include PRESS(digits) in your reply,
e.g. PRESS(1) or PRESS(123#); use w for a half-second pause, e.g. PRESS(1w2). The keys are
dialed after your spoken sentences. [caller pressed keys: ...] turns tell you what THEY dialed.
The caller's turns are prefixed with an annotation of how they spoke (volume, pace,
stuttering) — adapt to it.
When the conversation should end, include the word ${HANGUP_MARKER} anywhere in your reply.`;

const PRESS_PATTERN = /PRESS\(([0-9A-Da-d*#wW]{1,32})\)/g;

const HOLD_LINE = 'One moment while I check that for you.';
const REASSURE_LINE = 'Thanks for your patience — still checking.';
const CALLBACK_LINE =
  "I can't get that answer while we're on the line, so I'm going to hang up, take care of it right now, and call you back immediately.";
const REASSURE_AFTER_MS = 8000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** Hard cap on tool round-trips per caller turn (runaway protection). */
const MAX_TOOL_ROUNDS = 4;

/**
 * A control-socket client that drives a call with an LLM: transcripts (with
 * prosody annotations) go in, say commands come out. Sends clear (barge-in)
 * when the caller starts talking over the agent. Tool calls the model makes
 * are surfaced via onToolRequest and answered via provideToolResult; when an
 * answer cannot arrive in time, the agent promises an immediate callback and
 * ends the call.
 */
export class Orchestrator {
  private ws: WebSocket | null = null;
  private readonly history: ChatMessage[] = [];
  private readonly turns: ConversationTurn[] = [];
  private sayCounter = 0;
  private readonly saysInFlight = new Set<string>();
  private pendingUserTexts: string[] = [];
  private llmBusy = false;
  private lastTranscript: TranscriptMessage | null = null;
  private hangupAfterSayId: string | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private finished = false;
  /** Bumped on every barge-in; says from an older generation are stale. */
  private bargeInGeneration = 0;
  private dtmfBuffer = '';
  private dtmfTimer: NodeJS.Timeout | null = null;
  private resolveRun: ((result: CallResult) => void) | null = null;
  private readonly pendingToolWaits = new Map<string, (result: string) => void>();
  private toolHoldActive = false;
  private abortToolWait: (() => void) | null = null;

  constructor(private readonly opts: OrchestratorOptions) {
    this.history.push({ role: 'system', content: opts.systemPrompt + SYSTEM_SUFFIX });
  }

  run(): Promise<CallResult> {
    return new Promise((resolve, reject) => {
      this.resolveRun = resolve;
      const ws = new WebSocket(this.opts.controlUrl);
      this.ws = ws;
      ws.on('error', (err) => {
        if (!this.finished) reject(err);
      });
      ws.on('message', (data: Buffer | string) => this.onMessage(data.toString()));
      ws.on('close', () => this.finish('failed', 'control socket closed'));
    });
  }

  /** Feed a tool result back in while the call is live. False if nothing was waiting. */
  provideToolResult(requestId: string, result: string): boolean {
    const resolve = this.pendingToolWaits.get(requestId);
    if (!resolve) return false;
    resolve(result);
    return true;
  }

  private flushDtmf(): void {
    if (this.dtmfTimer) {
      clearTimeout(this.dtmfTimer);
      this.dtmfTimer = null;
    }
    if (this.dtmfBuffer.length === 0 || this.finished) return;
    const keys = this.dtmfBuffer;
    this.dtmfBuffer = '';
    this.turns.push({ role: 'caller', text: `[pressed ${keys}]` });
    this.pendingUserTexts.push(`[caller pressed keys: ${keys}]`);
    void this.respond();
  }

  private finish(finalState: 'ended' | 'failed', reason?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.disarmSilenceTimer();
    if (this.dtmfTimer) clearTimeout(this.dtmfTimer);
    this.abortToolWait?.();
    this.resolveRun?.({ finalState, reason, turns: this.turns });
    this.ws?.close();
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private onMessage(raw: string): void {
    const result = parseServerMessage(raw);
    if (!result.ok) return;
    const msg = result.message;
    this.opts.onEvent?.(msg);

    switch (msg.type) {
      case 'call.state':
        if (msg.state === 'active') this.onCallActive();
        if (msg.state === 'ended') this.finish('ended', msg.reason);
        if (msg.state === 'failed') this.finish('failed', msg.reason);
        break;
      case 'dtmf':
        this.disarmSilenceTimer();
        // Keys often come in bursts (extensions, PINs): buffer briefly and
        // hand the LLM the whole sequence as one turn.
        this.dtmfBuffer += msg.digit;
        if (this.dtmfTimer) clearTimeout(this.dtmfTimer);
        this.dtmfTimer = setTimeout(() => this.flushDtmf(), this.opts.dtmfFlushMs ?? 1200);
        break;
      case 'transcript': {
        const recentAgentTexts = this.turns
          .filter((t) => t.role === 'agent')
          .slice(-2)
          .map((t) => t.text);
        if (isEchoOfAgent(msg.text, recentAgentTexts)) break;
        this.disarmSilenceTimer();
        this.lastTranscript = msg;
        this.turns.push({ role: 'caller', text: msg.text, annotation: formatProsody(msg) });
        this.pendingUserTexts.push(`${formatProsody(msg)} "${msg.text}"`);
        void this.respond();
        break;
      }
      case 'speech.started':
        // Energy alone is NOT a barge-in trigger: on noisy lines the VAD
        // fires continuously and would mute the agent completely (observed
        // in the field). Words are the trigger — see transcript.delta.
        this.disarmSilenceTimer();
        break;
      case 'transcript.delta':
        // Barge-in: the STT recognizes actual words while we are speaking —
        // stop our audio and mark any still-streaming reply as superseded.
        if (this.saysInFlight.size > 0) {
          this.bargeInGeneration++;
          this.send({ type: 'clear' });
        }
        break;
      case 'say.completed':
        this.saysInFlight.delete(msg.id);
        if (this.hangupAfterSayId === msg.id) {
          this.send({ type: 'hangup' });
        } else if (this.saysInFlight.size === 0) {
          this.armSilenceTimer();
        }
        break;
      case 'say.aborted':
        this.saysInFlight.delete(msg.id);
        if (this.hangupAfterSayId === msg.id) this.send({ type: 'hangup' });
        break;
      default:
        break;
    }
  }

  private onCallActive(): void {
    if (this.opts.openingLine) {
      this.say(this.opts.openingLine);
    } else {
      this.pendingUserTexts.push('[The call has just been answered. Open the conversation.]');
      void this.respond();
    }
  }

  private async respond(): Promise<void> {
    if (this.llmBusy) return;
    this.llmBusy = true;
    try {
      while (
        this.pendingUserTexts.length > 0 &&
        !this.finished &&
        this.hangupAfterSayId === null
      ) {
        const userContent = this.pendingUserTexts.splice(0).join('\n');
        // Restating the objective every turn keeps long calls from drifting.
        const prefix = this.opts.objective ? `[Objective: ${this.opts.objective}]\n` : '';
        this.history.push({ role: 'user', content: prefix + userContent });
        await this.generateUntilSpoken();
      }
    } finally {
      this.llmBusy = false;
    }
  }

  /**
   * One caller turn: generate a reply, running as many tool round-trips as
   * the model asks for (each held on the line), until it produces a spoken
   * reply — or promise a callback when a tool result cannot arrive in time.
   */
  private async generateUntilSpoken(): Promise<void> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let reply: Awaited<ReturnType<typeof this.streamReply>>;
      try {
        reply = await this.streamReply();
      } catch (error) {
        // An LLM failure shouldn't strand the callee on a silent line.
        this.say('Sorry, something went wrong on my end. Goodbye.');
        this.hangupAfterSayId = `say-${this.sayCounter}`;
        throw error;
      }

      const spokenFull = reply.full
        .replaceAll(HANGUP_MARKER, '')
        .replace(PRESS_PATTERN, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (reply.toolCalls.length === 0) {
        this.history.push({ role: 'assistant', content: reply.full });
        if (spokenFull.length > 0) this.turns.push({ role: 'agent', text: spokenFull });
        for (const digits of reply.pressed) {
          this.turns.push({ role: 'agent', text: `[pressed ${digits}]` });
        }
        const wantsHangup = reply.full.includes(HANGUP_MARKER);
        if (wantsHangup) {
          if (reply.lastSayId) this.hangupAfterSayId = reply.lastSayId;
          else this.send({ type: 'hangup' });
        }
        return;
      }

      // Tool round: hold the line, surface the requests, wait for answers.
      this.history.push({ role: 'assistant', content: reply.full, toolCalls: reply.toolCalls });
      if (spokenFull.length > 0) this.turns.push({ role: 'agent', text: spokenFull });
      if (!reply.lastSayId) this.say(HOLD_LINE);
      for (const call of reply.toolCalls) this.opts.onToolRequest?.(call);

      const results = await this.waitForToolResults(reply.toolCalls);
      if (this.finished) return;

      const missing = reply.toolCalls.filter((c) => !results.has(c.id));
      for (const call of reply.toolCalls) {
        this.history.push({
          role: 'tool',
          toolCallId: call.id,
          content:
            results.get(call.id) ??
            'Result not available during the call. You promised to handle it right now and call back immediately.',
        });
      }
      if (missing.length > 0) {
        this.opts.onToolTimeout?.(missing.map((m) => m.id));
        this.hangupAfterSayId = this.say(CALLBACK_LINE);
        return;
      }
      // Results in hand: loop for the next generation round.
    }
    // The model kept chaining tools without ever speaking: bail out honestly.
    this.hangupAfterSayId = this.say(CALLBACK_LINE);
  }

  private waitForToolResults(calls: ToolCallRequest[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    this.toolHoldActive = true;
    const reassure = setTimeout(() => {
      if (!this.finished) this.say(REASSURE_LINE, { recordTurn: false });
    }, REASSURE_AFTER_MS);

    return new Promise<Map<string, string>>((resolve) => {
      const timer = setTimeout(() => done(), this.opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
      const done = (): void => {
        clearTimeout(timer);
        clearTimeout(reassure);
        for (const call of calls) this.pendingToolWaits.delete(call.id);
        this.toolHoldActive = false;
        this.abortToolWait = null;
        resolve(results);
      };
      this.abortToolWait = done;
      for (const call of calls) {
        this.pendingToolWaits.set(call.id, (result) => {
          results.set(call.id, result);
          if (results.size === calls.length) done();
        });
      }
    });
  }

  /** Sentence boundary: terminal punctuation (optionally a closing quote) then whitespace. */
  private static readonly SENTENCE_BOUNDARY = /[.!?…]["')\]]?\s/;

  /**
   * Stream the LLM reply, speaking each completed sentence immediately so the
   * first sentence plays while the rest is still generating. Falls back to a
   * single say when the chat client cannot stream.
   */
  private async streamReply(): Promise<{
    full: string;
    lastSayId: string | null;
    pressed: string[];
    toolCalls: ToolCallRequest[];
  }> {
    const generation = this.bargeInGeneration;
    let full = '';
    let buffer = '';
    let lastSayId: string | null = null;
    let toolCalls: ToolCallRequest[] = [];
    const flush = (text: string): void => {
      const spoken = text
        .replaceAll(HANGUP_MARKER, '')
        .replace(PRESS_PATTERN, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (spoken.length === 0) return;
      // A barge-in or hangup makes the rest of this reply stale: stay quiet.
      if (this.finished || this.bargeInGeneration !== generation) return;
      lastSayId = this.say(spoken, { recordTurn: false });
    };
    if (this.opts.chatClient.streamTurn) {
      const stream = this.opts.chatClient.streamTurn([...this.history], this.opts.tools ?? []);
      for await (const delta of stream) {
        if ('toolCalls' in delta) {
          toolCalls = toolCalls.concat(delta.toolCalls);
          continue;
        }
        full += delta.text;
        buffer += delta.text;
        for (;;) {
          const match = Orchestrator.SENTENCE_BOUNDARY.exec(buffer);
          if (!match) break;
          const cut = match.index + match[0].length;
          flush(buffer.slice(0, cut));
          buffer = buffer.slice(cut);
        }
      }
    } else {
      full = await this.opts.chatClient.complete([...this.history]);
      buffer = full;
    }
    flush(buffer);
    // Keypad presses the LLM asked for are dialed after its spoken sentences
    // (the say queue preserves order).
    const pressed: string[] = [];
    for (const match of full.matchAll(PRESS_PATTERN)) {
      if (this.finished || this.bargeInGeneration !== generation) break;
      const id = `say-${++this.sayCounter}`;
      this.saysInFlight.add(id);
      this.send({ type: 'sendDigits', id, digits: match[1]! });
      pressed.push(match[1]!);
      lastSayId = id;
    }
    return { full, lastSayId, pressed, toolCalls };
  }

  private say(rawText: string, opts: { recordTurn?: boolean } = {}): string {
    // LLMs sometimes wrap replies in quotation marks despite instructions;
    // spoken text must not include them.
    const text = rawText.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '') || rawText;
    const id = `say-${++this.sayCounter}`;
    this.saysInFlight.add(id);
    if (opts.recordTurn !== false) this.turns.push({ role: 'agent', text });
    this.send({
      type: 'say',
      id,
      text,
      ...(this.opts.voice ? { voice: this.opts.voice } : {}),
      ...(() => {
        const instructions = deriveTtsInstructions(this.lastTranscript);
        return instructions ? { instructions } : {};
      })(),
    });
    return id;
  }

  private armSilenceTimer(): void {
    const timeoutMs = this.opts.turnTimeoutMs ?? 0;
    if (timeoutMs <= 0 || this.finished || this.toolHoldActive) return;
    this.disarmSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.pendingUserTexts.push(
        '[The caller has been silent for a while. Briefly restate where things stand toward the objective, or ask the single next question you need. If the objective is done, say goodbye and HANGUP.]',
      );
      void this.respond();
    }, timeoutMs);
  }

  private disarmSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
