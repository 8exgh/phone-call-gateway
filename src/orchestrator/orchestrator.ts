import WebSocket from 'ws';
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type TranscriptMessage,
} from '../protocol/messages';
import type { ChatClient, ChatMessage } from './chatClient';

/** When the LLM's reply contains this marker, the call is ended after speaking. */
export const HANGUP_MARKER = 'HANGUP';

export interface OrchestratorOptions {
  /** ws:// URL of the gateway's control socket for the call. */
  controlUrl: string;
  chatClient: ChatClient;
  /** Persona and goal for the call. */
  systemPrompt: string;
  /** Fixed opening line; when omitted the LLM is asked to open the call. */
  openingLine?: string;
  voice?: string;
  /** ms of caller silence (after our say completes) before re-engaging; 0 disables. */
  turnTimeoutMs?: number;
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
natural, conversational sentences. No stage directions, no markdown, no surrounding quotation
marks. The caller's turns are prefixed with an annotation of how they spoke (volume, pace,
stuttering) — adapt to it.
When the conversation should end, include the word ${HANGUP_MARKER} anywhere in your reply.`;

/**
 * A control-socket client that drives a call with an LLM: transcripts (with
 * prosody annotations) go in, say commands come out. Sends clear (barge-in)
 * when the caller starts talking over the agent.
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
  private resolveRun: ((result: CallResult) => void) | null = null;

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

  private finish(finalState: 'ended' | 'failed', reason?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.disarmSilenceTimer();
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
        this.disarmSilenceTimer();
        // Barge-in: the caller is talking over us; stop our audio.
        if (this.saysInFlight.size > 0) this.send({ type: 'clear' });
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
        this.history.push({ role: 'user', content: userContent });
        let reply: string;
        try {
          reply = await this.opts.chatClient.complete([...this.history]);
        } catch (error) {
          // An LLM failure shouldn't strand the callee on a silent line.
          this.say('Sorry, something went wrong on my end. Goodbye.');
          this.hangupAfterSayId = `say-${this.sayCounter}`;
          throw error;
        }
        this.history.push({ role: 'assistant', content: reply });
        const wantsHangup = reply.includes(HANGUP_MARKER);
        const spoken = reply.replaceAll(HANGUP_MARKER, '').replace(/\s+/g, ' ').trim();
        if (spoken.length > 0) {
          const sayId = this.say(spoken);
          if (wantsHangup) this.hangupAfterSayId = sayId;
        } else if (wantsHangup) {
          this.send({ type: 'hangup' });
        }
      }
    } finally {
      this.llmBusy = false;
    }
  }

  private say(rawText: string): string {
    // LLMs sometimes wrap replies in quotation marks despite instructions;
    // spoken text must not include them.
    const text = rawText.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '') || rawText;
    const id = `say-${++this.sayCounter}`;
    this.saysInFlight.add(id);
    this.turns.push({ role: 'agent', text });
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
    if (timeoutMs <= 0 || this.finished) return;
    this.disarmSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.pendingUserTexts.push(
        '[The caller has been silent for a while. Re-engage them briefly, or wrap up the call.]',
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
