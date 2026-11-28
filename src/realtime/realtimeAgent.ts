import type { CallSession, MediaTap } from '../call/callSession';
import { decode as mulawDecode, encode as mulawEncode, MULAW_SILENCE } from '../audio/mulaw';
import { FrameChunker, MULAW_FRAME_BYTES } from '../audio/frames';
import { generateDtmf } from '../audio/dtmf';
import { ttsFallbackClip, TTS_FALLBACK_TEXT } from '../speech/ttsFallbackClip';
import { ProsodyAnalyzer } from '../prosody/prosodyAnalyzer';
import type { ToolCallRequest, ToolDef } from '../orchestrator/chatClient';
import type { CallResult, ConversationTurn } from '../orchestrator/orchestrator';
import { AdaptiveVad } from './adaptiveVad';
import type { RealtimeSocket, RealtimeSocketFactory } from './realtimeSocket';
import type { TtsStream, TtsUtterance } from '../speech/ttsStream';
import { classifyOverlap, type WordSpotter } from './wordSpotter';

/**
 * Turn-taking knobs. The realtime model answers about 0.6s after it is asked,
 * so WHEN it is asked — and when it is cut off — is what makes a call feel
 * natural. All values in milliseconds.
 */
export interface TurnTuning {
  /** Caller silence before a reply is requested (speculatively: it is dropped if they resume). */
  speculateAfterMs: number;
  /**
   * Shortest caller silence before a prepared reply may be spoken. People pause
   * this long mid-sentence; speaking sooner means talking over them.
   */
  patienceMinMs: number;
  /** Patience grows toward this for callers who are seen to pause longer mid-turn. */
  patienceMaxMs: number;
  /** An utterance with less speech than this is a word or two ("okay", "great", "hi")... */
  shortUtteranceMs: number;
  /** ...which usually has more coming, so wait this long before answering it. */
  shortWaitMs: number;
  /** While the agent talks: a second burst of caller speech within this long of the first is an interruption. */
  burstJoinMs: number;
  /** After a sound over the agent ends, how long to wait for its words before treating it as noise. */
  wordWaitMs: number;
  /**
   * A paused agent waits this long after the caller's sound ENDS before picking
   * back up (sooner if the sound is recognised as a listening noise): a word is
   * recognised a few hundred ms after it is finished, and resuming just before
   * "Stop" arrives means talking over the person who said it. Kept short: a
   * long pause after "uh-huh" makes the caller think the agent has finished.
   */
  wordGraceMs: number;
  /** ...and never sooner than this long after the sound began. */
  minPauseMs: number;
  /**
   * Caller speech over the agent before the agent pauses. A pause is not yet an
   * interruption: if the sound turns out to be short ("mm-hmm") the agent
   * picks its sentence back up.
   */
  pauseMs: number;
  /** Caller speech over the agent that settles it: they have taken the floor and the agent stops for good. */
  bargeInMs: number;
  /** While the agent has been talking for less than this, it yields almost immediately... */
  yieldWindowMs: number;
  /** ...after this much caller speech (they were not finished; the agent jumped in). */
  yieldMs: number;
  /** A sound made over the agent that stops for this long was a listening noise, not an interruption. */
  backchannelGapMs: number;
  /** After the model decides the caller is mid-thought, wait this long for more before answering anyway. */
  holdMaxMs: number;
  /** Audio kept from just before speech was detected, so first syllables are not lost. */
  prerollMs: number;
  /** Sounds shorter than this are line noise, not an utterance. */
  minUtteranceMs: number;
  /**
   * Echo gate, starting value: inbound sound quieter than this fraction of what
   * we are playing is taken to be our own voice coming back (0 = never gate).
   * Within a second or two of speaking it is replaced by what the line is
   * measured to send back: nothing on most lines, more on a speakerphone.
   */
  echoRatio: number;
  /**
   * Longest silence left inside the agent's own speech. The model sometimes
   * pauses close to a second between sentences, which sounds like it has
   * finished and invites the caller to start talking over the rest.
   */
  maxAgentPauseMs: number;
  /**
   * 1: when the caller carries on after a pause, withdraw what was committed and
   * give the model the whole turn again as one piece of audio (best judgement of
   * whether they have finished; costs model time on the re-sent audio).
   * 0: leave the pieces as they are and add the new one after them.
   */
  resendWholeTurn: number;
}

export const DEFAULT_TUNING: TurnTuning = {
  speculateAfterMs: 140,
  patienceMinMs: 700,
  patienceMaxMs: 1000,
  shortUtteranceMs: 600,
  shortWaitMs: 850,
  burstJoinMs: 1000,
  wordWaitMs: 600,
  wordGraceMs: 300,
  minPauseMs: 600,
  pauseMs: 140,
  bargeInMs: 700,
  yieldWindowMs: 700,
  yieldMs: 120,
  backchannelGapMs: 200,
  holdMaxMs: 2000,
  prerollMs: 300,
  minUtteranceMs: 100,
  echoRatio: 0.25,
  maxAgentPauseMs: 450,
  resendWholeTurn: 1,
};

export const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;

export interface RealtimeAgentOptions {
  session: CallSession;
  socketFactory: RealtimeSocketFactory;
  model: string;
  /** Reasoning effort for models that reason (e.g. "minimal"); omit for models that do not. */
  reasoningEffort?: string;
  /** One of REALTIME_VOICES; anything else falls back to defaultVoice. */
  voice?: string;
  defaultVoice: string;
  /**
   * Speak with an outside voice instead of the model's own: the model writes
   * its replies as text and this stream turns them into audio as they come.
   * `key` names the voice (for caching exact lines).
   */
  tts?: { stream: TtsStream; key: string };
  /**
   * Hears the caller's first words while the agent is talking. With it, the
   * agent talks straight through "mm-hmm" and stops for real words; without
   * it, the agent pauses at any sound and resumes if the sound was short.
   */
  wordSpotter?: WordSpotter;
  /** ISO-639-1 hint for the caller-side transcript. */
  language?: string;
  systemPrompt: string;
  objective?: string;
  openingLine?: string;
  tools?: ToolDef[];
  toolTimeoutMs?: number;
  onToolRequest?: (request: ToolCallRequest) => void;
  onToolTimeout?: (requestIds: string[]) => void;
  /** ms of silence after the agent finishes before it re-engages; 0 disables. */
  turnTimeoutMs?: number;
  awaitGreeting?: boolean;
  greetingWaitMs?: number;
  dtmfFlushMs?: number;
  onLlmError?: (message: string) => void;
  /** One line per notable moment, for the call's debug timeline. */
  onTimeline?: (text: string) => void;
  /** A finished caller line, prosody-annotated: "[normal, fast] text". */
  onCallerLine?: (line: string) => void;
  onError?: (message: string) => void;
  tuning?: Partial<TurnTuning>;
}

const HOLD_LINE = 'One moment while I check that for you.';
const REASSURE_LINE = 'Thanks for your patience, still checking.';
const CALLBACK_LINE =
  "I can't get that answer while we're on the line, so I'm going to hang up, take care of it right now, and call you back immediately.";
const REASSURE_AFTER_MS = 8000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_ROUNDS = 4;
const STALL_RETRY_MS = 2500;
/** After this many prompts in a row with no answer, say goodbye and hang up. */
const MAX_UNANSWERED_PROMPTS = 2;
const TTS_SILENT_MS = 6000;

/**
 * Exact lines already spoken once (greetings, hold messages), keyed by model,
 * voice and text. A persona's greeting is the same on every call, so from the
 * second call on it plays the instant the line connects.
 */
const cannedAudio = new Map<string, Uint8Array[]>();
const CANNED_CACHE_LIMIT = 100;

/** Forget cached greetings (tests; or after changing how lines are rendered). */
export function clearCannedAudioCache(): void {
  cannedAudio.clear();
}
const SILENT_FRAME = new Uint8Array(MULAW_FRAME_BYTES).fill(MULAW_SILENCE);
const ZERO_PCM = new Int16Array(MULAW_FRAME_BYTES);
const ECHO_LOOKBACK_FRAMES = 40;
const ECHO_LOOKAHEAD_FRAMES = 10;

export const CONTROL_TOOLS = [
  {
    type: 'function',
    name: 'keep_listening',
    description:
      'Stay silent and keep listening because the caller has clearly not finished their sentence or thought. Call this INSTEAD of speaking.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'end_call',
    description:
      'Hang up the phone. Call this in the same turn as your spoken goodbye, once the conversation is over or the objective is done.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'press_keys',
    description:
      'Press phone keypad keys (for automated menus: "press 1 for..."). The tones are sent after anything you say in this turn.',
    parameters: {
      type: 'object',
      properties: { digits: { type: 'string', description: 'Keys 0-9, *, #; w pauses half a second. Example: "1w2#"' } },
      required: ['digits'],
    },
  },
];

export function buildInstructions(opts: RealtimeAgentOptions): string {
  return `${opts.systemPrompt}
${opts.objective ? `\nObjective for this call: ${opts.objective}\n` : ''}
You are speaking on a live phone call. Talk like a person on the phone: one short sentence per turn where you can, two at most, and well under 25 words unless you are reading details back. Answer what was asked and stop; do not tack on offers or extra questions that the objective does not need. No lists, no markup.

Be relentlessly goal-oriented:
- Every turn must move the call toward the objective. Keep track of what you still need.
- If the conversation drifts, acknowledge in a few words and steer straight back.
- Ask for exactly one thing at a time. Read important details back (names, dates, numbers).
- The moment the objective is achieved, or clearly cannot be, confirm the outcome in one sentence, say goodbye, and call end_call. Never linger or make small talk.

When you need information or an action you don't have at hand (a calendar, a lookup, a computation, the web, a file), call one of your tools instead of guessing or stalling. If a result cannot arrive during the call, tell the caller you will take care of it right now and call them back immediately, then call end_call.

Turn-taking: the caller's audio reaches you in pieces, cut at every short pause, so a piece is often only part of what they are saying. Judge the latest piece together with the pieces before it. If they are clearly not finished (the sentence is incomplete, it ends on a filler or connective like "um", "and", "so", "about", "my name is", or they said they need a moment to think), do not speak: call keep_listening so they can go on. Do this every time it applies, however many times in a row. If what they have said is a complete question, answer or statement, reply normally and do not call keep_listening.

If the caller cuts you off, they did not want the rest of what you were saying: never pick it back up or repeat it. Respond to what they said instead. If they asked for or about something, answer exactly that, even if they began with "stop" or "wait". Only when "stop", "wait", "hold on" or the like is the whole of what they said do you simply hand them the floor in a few words ("Sure, go ahead.").

Text in [square brackets] is a note from the phone system, not something the caller said; never read it aloud. "[caller pressed keys: ...]" tells you what they dialed. To press keys yourself (automated menus), call press_keys.

If you reach voicemail or an answering machine (a recording that asks you to leave a message, or says the person is unavailable), nobody is listening live: leave one short message saying who is calling and why, then call end_call in the same turn. Do not ask questions or wait for an answer.

When the conversation is over (the caller says goodbye, or the objective is done), say a brief goodbye aloud and call end_call in the same turn. Never call end_call without speaking a goodbye in that same turn.${
    opts.tts
      ? `

Your reply is text that a speech engine reads aloud exactly as written, so write it the way it is said: numbers, prices, times and dates in words ("one hundred eighty-nine dollars", "nine a.m.", "two fourteen Riverside Drive"), phone numbers as single digits in words with commas between groups ("five eight seven, five five five, ..."), no symbols or abbreviations. This is only about how you write; never mention it to the caller.`
      : ''
  }`;
}

interface FunctionCall {
  callId: string;
  name: string;
  args: string;
}

/** One thing the model was asked to say (or decide), from request to last sound played. */
interface Reply {
  seq: number;
  /** turn: an answer in the conversation. canned: an exact line spoken outside it. */
  kind: 'turn' | 'canned';
  id?: string;
  /** Audio may be written to the call. Until then it is held back. */
  released: boolean;
  /** Dropped: ignore whatever else arrives for it. */
  cancelled: boolean;
  /** Generation finished (response.done seen). */
  done: boolean;
  /** Every audio frame generated so far, played or not. */
  frames: Uint8Array[];
  /** How many of them have been handed to the phone line. */
  written: number;
  /** The line started playing from frame playBaseIndex at wall time playBaseAt. */
  playBaseAt: number;
  playBaseIndex: number;
  /** Playback is suspended at frame pausedAt because the caller made a sound. */
  paused: boolean;
  pausedAt: number;
  /** Bumped whenever the line's buffer is cleared, so stale end-marks are ignored. */
  epoch: number;
  /** The response.create parameters, kept so a stalled request can be retried. */
  params: Record<string, unknown>;
  retried: boolean;
  watchdog: NodeJS.Timeout | null;
  /** Consecutive silent frames at the tail of frames (for trimming long pauses). */
  quietRun: number;
  /** When the model's first sound for this reply arrived. */
  firstAudioAt: number;
  /** With an outside voice: the speech being synthesized for this reply. */
  utterance?: TtsUtterance;
  /** With an outside voice: the model has finished writing this reply. */
  textDone?: boolean;
  /** This is the second ask after the model answered the caller with nothing. */
  afterEmpty?: boolean;
  chunker: FrameChunker;
  itemIds: string[];
  audioItemId?: string;
  audioDone: boolean;
  markName?: string;
  text: string;
  /** For canned lines: the exact words, recorded as the agent's turn. */
  cannedText?: string;
  calls: FunctionCall[];
  hangupAfter: boolean;
  digitsAfter?: string;
  /** Wall-clock ms of the caller's last sound before this reply was requested. */
  speechEndAt?: number;
  requestedAt: number;
  /** Do not release until open() says so (a pre-generated greeting). */
  gated: boolean;
  /** The caller's utterance this answers was only a word or two. */
  shortUtterance: boolean;
}

/**
 * Runs one call on a realtime speech model: the caller's audio goes straight
 * to the model and its voice comes straight back, with this class deciding
 * when the caller has finished (speculatively asking for a reply at a short
 * pause and dropping it if they carry on), letting the model hold when the
 * caller is mid-thought, cutting the agent off when really interrupted, and
 * ignoring "mm-hmm". Tools, keypad presses, hangup, greetings, and the
 * callback promise behave as they do in the classic orchestrator.
 */
export class RealtimeAgent implements MediaTap {
  private readonly tuning: TurnTuning;
  private readonly socket: RealtimeSocket;
  private readonly vad = new AdaptiveVad();
  private readonly analyzer = new ProsodyAnalyzer();
  private readonly startedAt = Date.now();
  private mediaClockMs = 0;

  private ready = false;
  private mediaStarted = false;
  private finished = false;
  private resolveRun: ((result: CallResult) => void) | null = null;
  private fatalError: string | null = null;

  // conversation record
  private readonly turns: (ConversationTurn & { itemId?: string })[] = [];
  private readonly callerTurnByItem = new Map<string, number>();

  // model responses
  private seq = 0;
  /** The response the server is currently generating. */
  private active: Reply | null = null;
  /** A response.create waiting for the active response to finish cancelling. */
  private pendingCreate: (() => void) | null = null;
  /** The newest reply whose audio has not been released to the call yet. */
  private waiting: Reply | null = null;
  /** The reply the caller is hearing (written to the call, not yet fully played). */
  private playing: Reply | null = null;

  // caller side
  private streaming = false;
  private preroll: Uint8Array[] = [];
  private utteranceLoudMs = 0;
  private bargeLoudMs = 0;
  private lastLoudAt = 0;
  private pauseHandled = true;
  private pendingCallerInput = false;
  /**
   * Everything the caller has said in the turn we have not answered yet, as
   * audio (pauses included). When they carry on after a pause, the model is
   * given the whole thing again as ONE piece: judged fragment by fragment it
   * cannot tell a finished thought from half of one.
   */
  private turnFrames: Uint8Array[] = [];
  /** Pieces of the current turn already committed to the model, oldest first. */
  private turnPieces: { itemId?: string; obsolete: boolean }[] = [];
  /** Transcript of the current turn's latest piece, once it arrives (often after the reply is ready). */
  private turnText = '';
  /** Commits sent whose item ids have not come back yet, in order. */
  private commitQueue: { itemId?: string; obsolete: boolean }[] = [];
  /** How long this caller is given to carry on before a prepared reply is spoken. */
  private patienceMs: number;
  /** End of the caller's last committed fragment that has not been answered aloud yet. */
  private unansweredSince = 0;
  /**
   * A sound the caller is making (or just made) over the agent, while its
   * words are awaited: loudMs across its bursts, what has been recognised.
   */
  private overlap: { loudMs: number; kind: 'none' | 'hum' | 'agreement' | 'words'; text: string; startedAt: number } | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  /** The model's "they are mid-thought" was already overruled once for this turn. */
  private holdOverruled = false;
  private overlapTimer: NodeJS.Timeout | null = null;
  private classifyTimer: NodeJS.Timeout | null = null;
  /** The caller said a word of agreement over the agent ("yeah"): answer it once the agent has finished. */
  private agreedOverAgent = false;
  /** End of the last short sound the caller made over the agent. */
  private overlapBurstEndAt = 0;
  private releaseTimer: NodeJS.Timeout | null = null;

  // echo gate
  /** Inbound sound quieter than this fraction of what we are playing is treated as our own echo. */
  private echoGate: number;
  private echoSamples: number[] = [];
  private playbackPeaks: number[] = [];
  private recentPlayedPeaks: number[] = [];

  // call flow
  private opened = false;
  private greetingReply: Reply | null = null;
  private greetingTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  /** Times in a row the line stayed silent after we prompted it. */
  private unansweredPrompts = 0;
  private holdTimer: NodeJS.Timeout | null = null;
  private holding = false;
  private dtmfBuffer = '';
  private dtmfTimer: NodeJS.Timeout | null = null;

  // tools
  private toolHoldActive = false;
  private toolRounds = 0;
  private readonly pendingToolWaits = new Map<string, (result: string) => void>();
  private abortToolWait: (() => void) | null = null;

  constructor(private readonly opts: RealtimeAgentOptions) {
    this.tuning = { ...DEFAULT_TUNING, ...(opts.tuning ?? {}) };
    this.patienceMs = this.tuning.patienceMinMs;
    this.echoGate = this.tuning.echoRatio;
    this.socket = opts.socketFactory(opts.model);
    this.socket.onOpen(() => this.configure());
    this.socket.onEvent((event) => {
      try {
        this.onEvent(event);
      } catch (error) {
        this.fail(`agent error: ${(error as Error).message}`);
      }
    });
    this.socket.onClosed((reason) => {
      if (!this.finished) this.fail(reason);
    });
    opts.wordSpotter?.onText((text) => this.onOverlapText(text));
  }

  run(): Promise<CallResult> {
    return new Promise((resolve) => {
      this.resolveRun = resolve;
      this.opts.session.attachTap(this);
    });
  }

  /** Feed a tool result back in while the call is live. False if nothing was waiting. */
  provideToolResult(requestId: string, result: string): boolean {
    const resolve = this.pendingToolWaits.get(requestId);
    if (!resolve) return false;
    resolve(result);
    return true;
  }

  // ---------- plumbing ----------

  private note(text: string): void {
    this.opts.onTimeline?.(text);
  }

  private send(event: Record<string, unknown>): void {
    if (!this.finished) this.socket.send(event);
  }

  private voice(): string {
    const wanted = this.opts.voice;
    if (wanted && (REALTIME_VOICES as readonly string[]).includes(wanted)) return wanted;
    return (REALTIME_VOICES as readonly string[]).includes(this.opts.defaultVoice) ? this.opts.defaultVoice : 'marin';
  }

  private configure(): void {
    const tools = (this.opts.tools ?? []).map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} },
    }));
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: [this.opts.tts ? 'text' : 'audio'],
        instructions: buildInstructions(this.opts),
        ...(this.opts.reasoningEffort ? { reasoning: { effort: this.opts.reasoningEffort } } : {}),
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            // Turn detection is ours: the built-in detectors wait ~0.8s.
            turn_detection: null,
            noise_reduction: { type: 'near_field' },
            transcription: { model: 'gpt-transcribe', ...(this.opts.language ? { language: this.opts.language } : {}) },
          },
          output: { format: { type: 'audio/pcmu' }, voice: this.voice() },
        },
        tools: [...CONTROL_TOOLS, ...tools],
        tool_choice: 'auto',
      },
    });
  }

  // ---------- call lifecycle (MediaTap) ----------

  onStart(): void {
    this.mediaStarted = true;
    this.note('media.started');
    if (this.opts.awaitGreeting && !this.opened) {
      // Let them speak first; open ourselves only if nobody says anything.
      this.greetingTimer = setTimeout(() => this.open(), this.opts.greetingWaitMs ?? 4000);
    } else {
      this.open();
    }
  }

  onMark(name: string): void {
    const reply = this.playing;
    if (reply && reply.markName === name) this.onPlayed(reply);
  }

  onDtmf(digit: string): void {
    this.disarmSilenceTimer();
    this.dtmfBuffer += digit;
    if (this.dtmfTimer) clearTimeout(this.dtmfTimer);
    this.dtmfTimer = setTimeout(() => {
      this.dtmfTimer = null;
      const keys = this.dtmfBuffer;
      this.dtmfBuffer = '';
      if (!keys || this.finished) return;
      this.turns.push({ role: 'caller', text: `[pressed ${keys}]` });
      this.opts.onCallerLine?.(`[key] ${keys}`);
      this.addNote(`[caller pressed keys: ${keys}]`);
      this.requestTurnReply();
    }, this.opts.dtmfFlushMs ?? 1200);
  }

  onClosed(state: 'ended' | 'failed', reason?: string): void {
    this.finish(state, reason);
  }

  private finish(finalState: 'ended' | 'failed', reason?: string): void {
    if (this.finished) return;
    if (this.fatalError !== null && finalState === 'ended') {
      finalState = 'failed';
      reason = this.fatalError;
    }
    // Whatever the agent was saying when the line dropped still counts as said.
    if (this.playing) this.recordAgentTurn(this.playing, this.playedFrames(this.playing) * 20);
    this.finished = true;
    for (const t of [this.greetingTimer, this.silenceTimer, this.holdTimer, this.dtmfTimer, this.releaseTimer, this.overlapTimer, this.classifyTimer, this.resumeTimer]) if (t) clearTimeout(t);
    this.opts.wordSpotter?.close();
    this.abortToolWait?.();
    this.socket.close();
    this.opts.tts?.stream.close();
    // Adjacent caller fragments (a thought spoken across pauses) read as one turn.
    const turns: ConversationTurn[] = [];
    for (const t of this.turns) {
      if (!t.text.trim()) continue;
      const prev = turns[turns.length - 1];
      if (prev && prev.role === 'caller' && t.role === 'caller' && !t.text.startsWith('[') && !prev.text.startsWith('[')) {
        prev.text = `${prev.text} ${t.text}`;
      } else {
        turns.push({ role: t.role, text: t.text, ...(t.annotation ? { annotation: t.annotation } : {}) });
      }
    }
    this.resolveRun?.({ finalState, reason, turns });
  }

  /** The model connection is gone or unusable: end the call rather than leave a silent line. */
  private fail(message: string): void {
    if (this.finished) return;
    if (this.fatalError === null) {
      this.fatalError = `llm_failed: ${message}`.slice(0, 500);
      this.opts.onLlmError?.(message);
      this.note(`fatal ${message}`);
    }
    if (this.mediaStarted && /quota|billing|insufficient|rate.?limit|429/i.test(message)) {
      // Say why before hanging up; the clip is pre-rendered and needs no provider.
      this.opts.session.tapClear();
      const clip = ttsFallbackClip();
      for (let i = 0; i + MULAW_FRAME_BYTES <= clip.length; i += MULAW_FRAME_BYTES) {
        this.opts.session.tapWrite(clip.subarray(i, i + MULAW_FRAME_BYTES));
      }
      this.turns.push({ role: 'agent', text: TTS_FALLBACK_TEXT });
      const timer = setTimeout(() => void this.opts.session.hangup(), Math.ceil(clip.length / 8) + 600);
      timer.unref();
    } else {
      void this.opts.session.hangup();
    }
  }

  // ---------- opening ----------

  /** Session is configured: get the first words ready before the line even connects. */
  private prepareOpening(): void {
    if (this.opts.openingLine) {
      this.greetingReply = this.speak(this.opts.openingLine, { gated: true });
    } else if (!this.opts.awaitGreeting) {
      this.addNote('[The call has just been answered. Open the conversation.]');
      const reply = this.requestTurnReply();
      if (reply) {
        reply.gated = true;
        this.greetingReply = reply;
      }
    }
    if (this.opened) this.open(true);
  }

  /** Start talking: the line is connected and (if we were waiting) nobody else spoke first. */
  private open(force = false): void {
    if ((this.opened && !force) || this.finished) return;
    this.opened = true;
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.greetingTimer = null;
    if (!this.ready) return; // prepareOpening will call back in
    if (this.greetingReply) {
      this.greetingReply.gated = false;
      this.tryRelease(this.greetingReply);
    } else if (this.opts.awaitGreeting && !this.opts.openingLine) {
      this.addNote('[The call has been answered but nobody has spoken. Open the conversation.]');
      this.requestTurnReply();
    }
  }

  // ---------- inbound audio ----------

  onFrame(mulaw: Uint8Array): void {
    if (this.finished) return;
    const pcm = mulawDecode(mulaw);
    const echo = this.isEcho(pcm);
    const frame = echo ? SILENT_FRAME : mulaw;
    const heard = echo ? ZERO_PCM : pcm;
    this.analyzer.pushFrame(heard, this.mediaClockMs);
    this.mediaClockMs += 20;
    if (!this.ready) return;

    const { loud, started } = this.vad.push(heard, echo);
    if (loud) this.lastLoudAt = Date.now();
    // (Fed while paused too: the pause is exactly when their words matter.)
    if (this.playing) this.opts.wordSpotter?.feed(frame);

    if (this.streaming) {
      this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(frame).toString('base64') });
    } else {
      this.preroll.push(frame);
      if (this.preroll.length > this.tuning.prerollMs / 20) this.preroll.shift();
    }
    // Keep the unanswered turn's audio (bounded: half a minute is plenty).
    if (this.turnFrames.length > 0 || this.streaming) {
      this.turnFrames.push(frame);
      if (this.turnFrames.length > 1500) this.turnFrames.shift();
    }

    if (started) this.onCallerSpeech();
    if (this.pauseHandled) return;

    if (loud) {
      this.utteranceLoudMs += 20;
      const reply = this.playing;
      if (reply) {
        this.bargeLoudMs += 20;
        if (this.overlap) this.overlap.loudMs += 20;
        if (this.overlap && (this.overlap.kind === 'hum' || this.overlap.kind === 'agreement')) {
          // Already recognised as a listening noise ("mm-hmm", "yeah"): we carry on talking.
        } else if (reply.paused) {
          // Still talking after we paused for them: they have the floor.
          if (this.bargeLoudMs >= this.tuning.bargeInMs) this.interrupt();
        } else if (
          reply.speechEndAt &&
          this.playedFrames(reply) * 20 < this.tuning.yieldWindowMs &&
          this.bargeLoudMs >= this.tuning.yieldMs
        ) {
          // We had only just started answering and they carried on: they were not finished.
          this.interrupt();
        } else if (this.bargeLoudMs >= this.tuning.pauseMs) {
          this.pausePlayback(reply);
        }
      }
      return;
    }
    const pause = this.playing ? this.tuning.backchannelGapMs : this.tuning.speculateAfterMs;
    if (this.vad.silenceMs >= pause) this.onCallerPause();
  }

  /** True while an inbound frame is judged to be our own voice coming back down the line. */
  private isEcho(inbound: Int16Array): boolean {
    if (this.tuning.echoRatio <= 0) return false;
    if (this.playbackPeaks.length > 0) {
      this.recentPlayedPeaks.push(this.playbackPeaks.shift()!);
      if (this.recentPlayedPeaks.length > ECHO_LOOKBACK_FRAMES) this.recentPlayedPeaks.shift();
    } else {
      // Nothing more is playing, but the last of what we said is still on its
      // way back: let the memory of it fade out rather than vanish.
      this.recentPlayedPeaks.shift();
      if (this.recentPlayedPeaks.length === 0) return false;
    }
    let ref = 0;
    for (const p of this.recentPlayedPeaks) ref = Math.max(ref, p);
    const ahead = Math.min(ECHO_LOOKAHEAD_FRAMES, this.playbackPeaks.length);
    for (let i = 0; i < ahead; i++) ref = Math.max(ref, this.playbackPeaks[i]!);
    let peak = 0;
    for (const s of inbound) peak = Math.max(peak, Math.abs(s));
    // Learn how much of our voice this particular line sends back. Most lines
    // send none; a speakerphone sends a lot. Sampled only while we are
    // actually playing, so a caller's own words barely count.
    if (this.playing && !this.playing.paused && ref > 3000) {
      this.echoSamples.push(peak / ref);
      if (this.echoSamples.length > 300) this.echoSamples.shift();
      if (this.echoSamples.length >= 50 && this.echoSamples.length % 25 === 0) this.learnEcho();
    }
    return peak < this.echoGate * ref;
  }

  /** Set the echo gate from what this line has actually been sending back. */
  private learnEcho(): void {
    const sorted = [...this.echoSamples].sort((a, b) => a - b);
    // The loud end of the distribution: echo is only as loud as the words it echoes,
    // and our own speech is mostly gaps and quiet syllables.
    const level = sorted[Math.floor(sorted.length * 0.9)]!;
    let gate = level < 0.03 ? 0 : Math.min(0.5, Math.max(0.1, level * 1.6));
    // Echo takes most of a second to come back, so the first samples of a call
    // always look clean: only relax the gate once there are three seconds of evidence.
    if (this.echoSamples.length < 150) gate = Math.max(gate, this.echoGate);
    if (Math.abs(gate - this.echoGate) >= 0.05) {
      this.note(gate === 0 ? 'echo gate off (this line sends none of our voice back)' : `echo gate ${gate.toFixed(2)} (line echo about ${(level * 100).toFixed(0)}%)`);
    }
    this.echoGate = gate;
  }

  /** Words recognised from what the caller is saying over the agent. */
  private onOverlapText(text: string): void {
    if (this.finished || !this.playing || !this.overlap) return;
    this.overlap.text = text;
    // Words arrive in pieces (" M", "mm", ","), sometimes a few hundred ms apart
    // (" A" ... "ha"): judge once the last word is closed by punctuation or a
    // space, or has had time to finish.
    if (this.classifyTimer) clearTimeout(this.classifyTimer);
    // A one- or two-letter fragment ("A" on its way to "Aha") gets longer to finish
    // than something that already looks like a word.
    const fragment = /(^|\s)\S{1,2}$/.test(text);
    const settle = /[\s,.!?]$/.test(text) ? 0 : fragment ? 700 : 300;
    this.classifyTimer = setTimeout(() => {
      this.classifyTimer = null;
      const overlap = this.overlap;
      if (!overlap || !this.playing || this.finished) return;
      const kind = classifyOverlap(overlap.text);
      if (kind === 'none') return;
      if (kind === 'words') {
        this.note(`caller took the floor: "${overlap.text.trim().slice(0, 60)}"`);
        // If they have already stopped talking ("Stop." / "Wait."), nothing else
        // will prompt a reply: what they said is their turn, so answer it.
        const alreadyQuiet = this.pauseHandled;
        this.interrupt();
        if (alreadyQuiet && !this.toolHoldActive) {
          this.commitTurn();
          this.unansweredSince = this.lastLoudAt;
          const reply = this.requestTurnReply();
          if (reply) reply.speechEndAt = this.lastLoudAt;
        }
        return;
      }
      if (overlap.kind !== kind) {
        this.note(`listening noise over agent ("${overlap.text.trim().slice(0, 40)}"): carrying on`);
        overlap.kind = kind;
      }
      if (this.playing.paused) {
        if (this.resumeTimer) clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
        this.resumePlayback(this.playing);
      }
      // If the sound has already stopped there is nothing more to wait for.
      if (this.pauseHandled) this.endOverlap(null);
    }, settle);
  }

  /** The sound over the agent is over and was not an interruption. */
  private endOverlap(note: string | null): void {
    const overlap = this.overlap;
    if (!overlap) return;
    if (note) this.note(note);
    if (overlap.kind === 'agreement') {
      // "Yeah" / "okay" may be an answer: keep it for when we have finished speaking.
      this.agreedOverAgent = true;
    } else if (!this.agreedOverAgent) {
      // A hum or a noise: nothing for the model to hear.
      this.send({ type: 'input_audio_buffer.clear' });
      if (this.turnPieces.length === 0) this.turnFrames = [];
    }
    this.overlap = null;
    if (this.overlapTimer) clearTimeout(this.overlapTimer);
    this.overlapTimer = null;
    this.opts.wordSpotter?.reset();
  }

  /** The caller started (or resumed) talking. */
  private onCallerSpeech(): void {
    this.note(this.playing ? 'caller.speech (over agent)' : 'caller.speech');
    this.disarmSilenceTimer();
    if (this.greetingTimer) {
      clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holding = false;

    // They carried on after a pause we were about to answer into: this caller
    // pauses that long mid-turn, so be that patient from now on.
    if (this.unansweredSince > 0) {
      const pausedMs = Date.now() - 60 - this.unansweredSince;
      if (pausedMs > 0 && pausedMs < 1500) {
        const wanted = Math.min(this.tuning.patienceMaxMs, pausedMs + 150);
        if (wanted > this.patienceMs) {
          this.patienceMs = wanted;
          this.note(`patience ${Math.round(wanted)}ms (caller paused ${pausedMs}ms mid-turn)`);
        }
      }
    }

    // Anything we had lined up to say was premature: they are not done. (Not
    // the greeting, unless we are letting them speak first: a noise on the
    // line as it connects must not swallow the hello.)
    const greeting = this.waiting !== null && this.waiting === this.greetingReply && !this.opts.awaitGreeting;
    if (this.waiting && !this.waiting.released && !greeting) {
      this.note(`reply.dropped (caller kept talking, ${Date.now() - this.waiting.requestedAt}ms after request)`);
      this.drop(this.waiting);
    }
    this.pendingCreate = null;

    this.pauseHandled = false;
    this.utteranceLoudMs = 60;
    this.bargeLoudMs = 60;
    this.streaming = true;
    // A second burst of speech over the agent, soon after the first, is someone
    // trying to get a word in ("Sorry, ... sorry, ..."), not a listening noise.
    const secondBurst =
      this.playing !== null &&
      (this.overlap === null || this.overlap.kind === 'none') &&
      (this.playing.paused || Date.now() - this.overlapBurstEndAt < this.tuning.burstJoinMs);
    if (this.playing && this.opts.wordSpotter && !secondBurst) {
      // Their words will say whether this is a listening noise or a bid for the floor.
      this.overlap ??= { loudMs: 60, kind: 'none', text: '', startedAt: Date.now() - 60 };
      if (this.overlapTimer) clearTimeout(this.overlapTimer);
      this.overlapTimer = null;
    }
    // The pre-roll already holds the first syllables (and the frame that confirmed speech).
    const earlier = this.tuning.resendWholeTurn ? this.turnPieces.filter((p) => !p.obsolete) : [];
    if (earlier.length > 0) {
      // They paused, we committed what they had said, and now they carry on.
      // Withdraw those pieces and give the model the whole turn so far as one
      // stretch of audio, with the rest following live. Doing it now, while
      // they are still talking, means nothing is left to upload when they stop.
      for (const piece of earlier) {
        piece.obsolete = true;
        if (piece.itemId) this.withdrawPiece(piece.itemId);
      }
      this.send({ type: 'input_audio_buffer.clear' });
      const frames = this.turnFrames;
      for (let i = 0; i < frames.length; i += 50) {
        const chunk = Buffer.concat(frames.slice(i, i + 50).map((f) => Buffer.from(f)));
        this.send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
      }
      this.note(`turn continues (${frames.length * 20}ms so far, re-sent whole)`);
    } else {
      for (const f of this.preroll) {
        this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(f).toString('base64') });
      }
      // The frame that confirmed speech is already in turnFrames when a turn is open.
      if (this.turnFrames.length === 0) this.turnFrames = [...this.preroll];
      if (this.turnPieces.length > 0) this.note('turn continues (new piece)');
    }
    this.preroll = [];
    if (secondBurst) this.interrupt();
  }

  /** The caller went quiet after speaking. */
  private onCallerPause(): void {
    this.pauseHandled = true;
    this.vad.endUtterance();
    this.streaming = false;

    if (this.playing) {
      // They made a sound while we talked but did not take the floor: most
      // likely a listening noise ("mm-hmm"). Carry on where we left off. The
      // sound stays buffered: if they speak again right away it was the start
      // of an interruption and the model should hear all of it.
      if (this.utteranceLoudMs >= this.tuning.minUtteranceMs) this.overlapBurstEndAt = Date.now() - this.vad.silenceMs;
      if (this.opts.wordSpotter && this.overlap) {
        // The sound has stopped. We carry on, but if its words have not arrived
        // yet they still count for a moment: a lone "Wait." deserves the floor.
        if (this.overlap.kind === 'none') {
          if (this.playing.paused) {
            // Their sound has stopped, but its first word may still be on its way.
            const reply = this.playing;
            const soundEndedAt = Date.now() - this.vad.silenceMs;
            const waitMs = Math.max(soundEndedAt + this.tuning.wordGraceMs, this.overlap.startedAt + this.tuning.minPauseMs) - Date.now();
            if (this.resumeTimer) clearTimeout(this.resumeTimer);
            this.resumeTimer = setTimeout(
              () => {
                this.resumeTimer = null;
                if (this.playing === reply && reply.paused && this.pauseHandled && !this.finished) this.resumePlayback(reply);
              },
              Math.max(0, waitMs),
            );
          }
          if (this.overlapTimer) clearTimeout(this.overlapTimer);
          this.overlapTimer = setTimeout(() => {
            this.overlapTimer = null;
            if (this.overlap?.kind === 'none') this.endOverlap(`sound over agent ignored (${this.overlap.loudMs}ms, no words)`);
          }, this.tuning.wordWaitMs);
        } else {
          this.endOverlap(null);
        }
        return;
      }
      if (this.playing.paused) this.resumePlayback(this.playing);
      else this.note(`sound over agent ignored (${this.utteranceLoudMs}ms)`);
      return;
    }
    if (this.utteranceLoudMs < this.tuning.minUtteranceMs) {
      // A click or a cough, not words. If it interrupted an answer we were
      // about to give, that answer is still owed.
      if (this.unansweredSince > 0 && !this.toolHoldActive) {
        // (The turn was re-sent whole when the sound began, so commit it again.)
        const speechEndAt = this.unansweredSince;
        this.commitTurn();
        if (!this.holding) {
          const reply = this.requestTurnReply();
          if (reply) reply.speechEndAt = speechEndAt;
        }
      } else {
        this.send({ type: 'input_audio_buffer.clear' });
        if (this.turnPieces.length === 0) this.turnFrames = [];
      }
      return;
    }

    if (this.opts.awaitGreeting && !this.opened) {
      // They spoke first: answer them instead of reciting the opening over the top.
      this.opened = true;
      if (this.greetingReply) {
        this.drop(this.greetingReply);
        this.greetingReply = null;
      }
      if (this.opts.openingLine) {
        this.addNote(
          `[The call has just been answered and they spoke first. Your planned opening was: "${this.opts.openingLine}". Answer them naturally instead.]`,
        );
      }
    }

    this.commitTurn();
    this.toolRounds = 0;
    this.unansweredPrompts = 0;
    if (this.toolHoldActive) {
      // Their words are in the conversation; the answer comes with the tool result.
      this.pendingCallerInput = true;
      return;
    }
    this.unansweredSince = this.lastLoudAt;
    const reply = this.requestTurnReply();
    if (reply) {
      reply.speechEndAt = this.lastLoudAt;
      reply.shortUtterance = this.utteranceLoudMs < this.tuning.shortUtteranceMs;
    }
  }

  /** Put what the caller has said so far this turn into the conversation as one piece of audio. */
  private commitTurn(): void {
    const piece = { obsolete: false } as { itemId?: string; obsolete: boolean };
    this.turnText = '';
    this.turnPieces.push(piece);
    this.commitQueue.push(piece);
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /** An earlier piece of the turn has been superseded by the whole turn: remove it everywhere. */
  private withdrawPiece(itemId: string): void {
    this.send({ type: 'conversation.item.delete', item_id: itemId });
    const index = this.callerTurnByItem.get(itemId);
    if (index !== undefined) {
      this.turns[index]!.text = '';
      this.callerTurnByItem.delete(itemId);
    }
  }

  /**
   * Do these words stop mid-sentence? A backstop for the model's own judgement,
   * usable only when the transcript beats the reply (patient callers). English only.
   */
  private trailsOff(text: string): boolean {
    if (!text || (this.opts.language ?? 'en') !== 'en') return false;
    const t = text.trim().toLowerCase();
    if (/[?!]$/.test(t)) return false;
    return /(^|[\s,])(um+|uh+|er+|erm|hmm+|and|but|or|so|because|like|about|with|for|to|of|the|a|an|is|are|my|your|at|on|in|if|that|which|my name is|it's|i'm)[\s,.…-]*$/.test(t);
  }

  /** The caller's turn has been answered aloud: the next thing they say starts a new one. */
  private closeTurn(): void {
    this.turnFrames = [];
    this.turnPieces = [];
    this.turnText = '';
    this.unansweredSince = 0;
    this.holdOverruled = false;
  }

  // ---------- asking the model to speak ----------

  private newReply(kind: Reply['kind']): Reply {
    return {
      seq: ++this.seq,
      kind,
      released: false,
      cancelled: false,
      done: false,
      frames: [],
      written: 0,
      playBaseAt: 0,
      playBaseIndex: 0,
      paused: false,
      pausedAt: 0,
      epoch: 0,
      params: {},
      retried: false,
      watchdog: null,
      quietRun: 0,
      firstAudioAt: 0,
      chunker: new FrameChunker(MULAW_FRAME_BYTES, MULAW_SILENCE),
      itemIds: [],
      audioDone: false,
      text: '',
      calls: [],
      hangupAfter: false,
      requestedAt: Date.now(),
      gated: false,
      shortUtterance: false,
    };
  }

  /** Only one response can generate at a time: cancel the current one first if needed. */
  private createResponse(reply: Reply, params: Record<string, unknown>): void {
    reply.params = params;
    const fire = (): void => {
      this.active = reply;
      reply.requestedAt = Date.now();
      this.send({ type: 'response.create', ...(Object.keys(params).length > 0 ? { response: params } : {}) });
      // The model normally answers in about half a second. If it has produced
      // nothing after a few seconds, ask again rather than leave dead air.
      reply.watchdog = setTimeout(() => this.onReplyStalled(reply), STALL_RETRY_MS);
    };
    if (this.waiting && !this.waiting.released && this.waiting !== reply) this.drop(this.waiting);
    this.waiting = reply;
    if (this.active) {
      this.cancelActive();
      this.pendingCreate = fire;
    } else {
      fire();
    }
  }

  private onReplyStalled(reply: Reply): void {
    reply.watchdog = null;
    if (this.finished || reply.cancelled || reply.done || reply.retried) return;
    if (this.active !== reply || reply.frames.length > 0 || reply.itemIds.length > 0) return;
    this.note(`model slow (${Date.now() - reply.requestedAt}ms, nothing yet): asking again`);
    const retry = this.newReply(reply.kind);
    retry.retried = true;
    retry.cannedText = reply.cannedText;
    retry.gated = reply.gated;
    retry.hangupAfter = reply.hangupAfter;
    retry.speechEndAt = reply.speechEndAt;
    retry.shortUtterance = reply.shortUtterance;
    if (this.greetingReply === reply) this.greetingReply = retry;
    this.createResponse(retry, reply.params);
  }

  private stopWatchdog(reply: Reply): void {
    if (reply.watchdog) clearTimeout(reply.watchdog);
    reply.watchdog = null;
  }

  private cancelActive(): void {
    const reply = this.active;
    if (!reply || reply.cancelled || reply.done) return;
    reply.cancelled = true;
    this.send({ type: 'response.cancel' });
  }

  /** Abandon a reply that has not been heard: stop generating it and erase it from the conversation. */
  private drop(reply: Reply): void {
    if (this.waiting === reply) this.waiting = null;
    if (reply.done) {
      reply.cancelled = true;
      this.eraseItems(reply);
    } else if (this.active === reply) {
      this.cancelActive();
    } else {
      reply.cancelled = true;
    }
    reply.utterance?.cancel();
    this.stopWatchdog(reply);
  }

  private eraseItems(reply: Reply): void {
    if (reply.kind !== 'turn') return;
    for (const id of reply.itemIds) this.send({ type: 'conversation.item.delete', item_id: id });
    reply.itemIds = [];
  }

  /** Ask the model for its next turn in the conversation. */
  private requestTurnReply(): Reply | null {
    if (this.finished || !this.ready) return null;
    const reply = this.newReply('turn');
    this.createResponse(reply, {});
    return reply;
  }

  /** Speak an exact line (greeting, hold message). It is added to the conversation once heard. */
  private speak(text: string, opts: { gated?: boolean; hangupAfter?: boolean } = {}): Reply {
    const reply = this.newReply('canned');
    reply.cannedText = text;
    reply.gated = opts.gated ?? false;
    reply.hangupAfter = opts.hangupAfter ?? false;
    const cached = cannedAudio.get(this.cannedKey(text));
    if (cached) {
      // Said before in this voice: no need to ask the model again.
      if (this.waiting && !this.waiting.released) this.drop(this.waiting);
      this.waiting = reply;
      reply.frames = [...cached];
      reply.firstAudioAt = reply.requestedAt;
      reply.audioDone = true;
      reply.done = true;
      this.tryRelease(reply);
      return reply;
    }
    if (this.opts.tts) {
      // The outside voice reads the exact words itself: no model involved.
      if (this.waiting && !this.waiting.released) this.drop(this.waiting);
      this.waiting = reply;
      reply.done = true;
      reply.utterance = this.beginUtterance(reply);
      // The whole line at once, so it is voiced as one natural piece.
      reply.utterance.end(text);
      return reply;
    }
    this.createResponse(reply, {
      conversation: 'none',
      input: [],
      tool_choice: 'none',
      instructions: `You are a voice on a phone call. Say exactly this, word for word, in a warm natural tone, and nothing else: "${text}"`,
    });
    return reply;
  }

  private cannedKey(text: string): string {
    return `${this.opts.tts ? `tts:${this.opts.tts.key}` : `${this.opts.model}|${this.voice()}`}|${text}`;
  }

  /** A system note in the conversation (not caller speech). */
  private addNote(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
  }

  // ---------- model events ----------

  private onEvent(event: Record<string, unknown>): void {
    const type = String(event.type ?? '');
    switch (type) {
      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          this.note('model.ready');
          this.prepareOpening();
        }
        return;
      case 'input_audio_buffer.committed': {
        const itemId = String(event.item_id ?? '');
        const piece = this.commitQueue.shift();
        if (piece) piece.itemId = itemId;
        if (piece?.obsolete) {
          // Superseded before its id even arrived.
          this.send({ type: 'conversation.item.delete', item_id: itemId });
          return;
        }
        this.turns.push({ role: 'caller', text: '', itemId });
        this.callerTurnByItem.set(itemId, this.turns.length - 1);
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const index = this.callerTurnByItem.get(String(event.item_id ?? ''));
        const text = String(event.transcript ?? '').trim();
        if (index === undefined || !text) return;
        const a = this.analyzer.annotate(text);
        const annotation = `[volume: ${a.volume.class}, pace: ${a.pace.class}${a.stutter.detected ? ', stuttering' : ''}]`;
        this.turns[index]!.text = text;
        this.turns[index]!.annotation = annotation;
        const latest = this.turnPieces[this.turnPieces.length - 1];
        if (latest && latest.itemId === String(event.item_id ?? '')) {
          this.turnText = text;
          if (this.endsInQuestion(text)) this.overruleHold();
        }
        this.note(`transcript "${text}"`);
        this.opts.onCallerLine?.(`[${a.volume.class}, ${a.pace.class}${a.stutter.detected ? ', stuttering' : ''}] ${text}`);
        return;
      }
      case 'response.created': {
        const response = event.response as { id?: string } | undefined;
        if (this.active && !this.active.id) this.active.id = response?.id;
        return;
      }
      case 'response.output_item.added': {
        const reply = this.replyFor(event);
        const item = event.item as { id?: string; type?: string } | undefined;
        if (!reply || !item?.id) return;
        reply.itemIds.push(item.id);
        if (item.type === 'message') reply.audioItemId = item.id;
        return;
      }
      case 'response.output_audio.delta': {
        const reply = this.replyFor(event);
        if (!reply || reply.cancelled) return;
        this.onAudio(reply, new Uint8Array(Buffer.from(String(event.delta ?? ''), 'base64')));
        return;
      }
      case 'response.output_audio.done': {
        const reply = this.replyFor(event);
        if (reply) this.onAudioDone(reply);
        return;
      }
      case 'response.output_text.delta': {
        // Outside voice: the model writes, the speech engine talks.
        const reply = this.replyFor(event);
        const tts = this.opts.tts;
        if (!reply || reply.cancelled || !tts) return;
        const delta = String(event.delta ?? '');
        reply.text += delta;
        reply.utterance ??= this.beginUtterance(reply);
        reply.utterance.push(delta);
        return;
      }
      case 'response.output_text.done': {
        const reply = this.replyFor(event);
        if (reply?.utterance) {
          reply.textDone = true;
          reply.utterance.end();
        }
        return;
      }
      case 'response.output_audio_transcript.delta': {
        const reply = this.replyFor(event);
        if (reply) reply.text += String(event.delta ?? '');
        return;
      }
      case 'response.output_item.done': {
        const reply = this.replyFor(event);
        const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        if (reply && item?.type === 'function_call' && item.call_id && item.name) {
          reply.calls.push({ callId: item.call_id, name: item.name, args: item.arguments || '{}' });
        }
        return;
      }
      case 'response.done':
        this.onResponseDone(event.response as { id?: string; status?: string; status_details?: unknown } | undefined);
        return;
      case 'error': {
        const error = (event.error ?? {}) as { code?: string; message?: string; type?: string };
        const text = `${error.code ?? error.type ?? 'error'}: ${error.message ?? ''}`;
        // Races with our own cancels and truncations are expected and harmless.
        if (/cancel|not_active|no active response|truncat|already has an active|buffer too small|buffer_empty/i.test(text)) {
          this.note(`model.note ${text}`.slice(0, 200));
          return;
        }
        this.note(`model.error ${text}`.slice(0, 300));
        this.opts.onError?.(`realtime: ${text}`.slice(0, 300));
        if (/invalid_api_key|insufficient_quota|billing|session_expired|invalid_model|model_not_found/i.test(text)) this.fail(text);
        return;
      }
      default:
        return;
    }
  }

  private replyFor(event: Record<string, unknown>): Reply | null {
    const id = event.response_id;
    if (this.active && (id === undefined || this.active.id === id)) return this.active;
    return null;
  }

  /** Start synthesizing a reply with the outside voice; its audio joins the usual playback path. */
  private beginUtterance(reply: Reply): TtsUtterance {
    // The speech engine normally answers in a fraction of a second. Silence
    // from it must end the call as failed, not leave the caller on a dead line.
    const silent = setTimeout(() => {
      if (this.finished || reply.cancelled || reply.frames.length > 0) return;
      // Nothing was written, so there was nothing to speak: not the speech engine's doing.
      if (reply.done && !(reply.cannedText ?? reply.text).trim()) return;
      this.note(
        `speech engine silent: text ${reply.textDone ? 'finished' : 'unfinished'}, reply ${reply.done ? 'done' : 'still generating'}, wrote "${(reply.cannedText ?? reply.text).trim().slice(0, 80)}"`,
      );
      this.opts.onError?.('tts_failed: the speech engine produced no audio');
      this.fail('tts_failed: the speech engine produced no audio');
    }, TTS_SILENT_MS);
    silent.unref();
    return this.opts.tts!.stream.begin(
      (mulaw) => {
        clearTimeout(silent);
        if (!reply.cancelled && !this.finished) this.onAudio(reply, mulaw);
      },
      () => {
        if (!this.finished) this.onAudioDone(reply);
      },
    );
  }

  /** All of a reply's audio has arrived. */
  private onAudioDone(reply: Reply): void {
    if (reply.cancelled || reply.audioDone) return;
    const tail = reply.chunker.flush();
    if (tail) this.queueFrame(reply, tail);
    reply.audioDone = true;
    if (reply.kind === 'canned' && reply.cannedText && reply.frames.length > 0) {
      if (cannedAudio.size >= CANNED_CACHE_LIMIT) cannedAudio.delete(cannedAudio.keys().next().value as string);
      cannedAudio.set(this.cannedKey(reply.cannedText), [...reply.frames]);
    }
    if (reply.released) this.markEnd(reply);
    else this.tryRelease(reply);
  }

  private onAudio(reply: Reply, bytes: Uint8Array): void {
    this.stopWatchdog(reply);
    for (const frame of reply.chunker.push(bytes)) this.queueFrame(reply, frame);
    if (!reply.released) this.tryRelease(reply);
  }

  private queueFrame(reply: Reply, frame: Uint8Array): void {
    let peak = 0;
    for (const s of mulawDecode(frame)) peak = Math.max(peak, Math.abs(s));
    if (peak < 300) {
      reply.quietRun++;
      // No dead air before the first word, and no stage pauses mid-reply.
      if (reply.frames.length === 0 || reply.quietRun * 20 > this.tuning.maxAgentPauseMs) return;
    } else {
      reply.quietRun = 0;
    }
    if (reply.frames.length === 0) reply.firstAudioAt = Date.now();
    reply.frames.push(frame);
    if (reply.released && !reply.paused) this.writePending(reply);
  }

  /** Hand every frame not yet on the line to the line. */
  private writePending(reply: Reply): void {
    if (reply.written >= reply.frames.length) return;
    if (reply.written === reply.playBaseIndex && reply.playBaseAt === 0) reply.playBaseAt = Date.now();
    for (; reply.written < reply.frames.length; reply.written++) {
      const frame = reply.frames[reply.written]!;
      if (this.tuning.echoRatio > 0) {
        let peak = 0;
        for (const s of mulawDecode(frame)) peak = Math.max(peak, Math.abs(s));
        this.playbackPeaks.push(peak);
      }
      this.opts.session.tapWrite(frame);
    }
  }

  /** Our best estimate of how many of a reply's frames the caller's line has played. */
  private playedFrames(reply: Reply): number {
    if (reply.paused) return reply.pausedAt;
    if (reply.playBaseAt === 0) return reply.playBaseIndex;
    return Math.min(reply.written, reply.playBaseIndex + Math.floor((Date.now() - reply.playBaseAt) / 20));
  }

  /** Let a reply's audio through if the line is up and the caller is not mid-sentence. */
  private tryRelease(reply: Reply): void {
    if (reply.released || reply.cancelled || reply.gated || !this.mediaStarted || reply.frames.length === 0) return;
    const opening = reply === this.greetingReply && !this.opts.awaitGreeting;
    if ((!this.pauseHandled && !opening) || this.playing) return;
    // Give the caller their beat of silence first: people pause mid-sentence.
    const waitMs = opening
      ? 0
      : this.vad.maybeSpeech
        ? 40
        : reply.speechEndAt
        ? reply.speechEndAt + (reply.shortUtterance ? Math.max(this.tuning.shortWaitMs, this.patienceMs) : this.patienceMs) - Date.now()
        : 0;
    if (waitMs > 0) {
      if (this.releaseTimer) clearTimeout(this.releaseTimer);
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        this.tryRelease(reply);
      }, waitMs);
      return;
    }
    if (reply.speechEndAt && !this.holding && this.trailsOff(this.turnText)) {
      // The model wanted to answer, but their words end mid-sentence ("...and, um").
      this.note(`hold (words trail off: "${this.turnText.slice(-40)}")`);
      this.drop(reply);
      this.hold();
      return;
    }
    // Whatever we are about to say, it answers what the caller has said so far.
    this.closeTurn();
    this.opts.wordSpotter?.reset();
    this.overlap = null;
    this.agreedOverAgent = false;
    reply.released = true;
    if (this.waiting === reply) this.waiting = null;
    this.playing = reply;
    this.disarmSilenceTimer();
    const now = Date.now();
    this.note(
      reply.speechEndAt
        ? `reply.start think=${now - reply.speechEndAt}ms (model answered in ${reply.firstAudioAt - reply.requestedAt}ms, waited ${now - reply.firstAudioAt}ms more for the caller)`
        : `reply.start (${reply.kind}, model ${reply.firstAudioAt - reply.requestedAt}ms)`,
    );
    this.writePending(reply);
    if (reply.audioDone) this.markEnd(reply);
  }

  private markEnd(reply: Reply): void {
    if (reply.paused || reply.markName === `r${reply.seq}.${reply.epoch}`) return;
    reply.markName = `r${reply.seq}.${reply.epoch}`;
    this.opts.session.tapMark(reply.markName);
  }

  /**
   * The caller made a sound over us. Stop the line at once, but keep our place:
   * if it was only "mm-hmm" we carry on; if they keep talking we stop for good.
   */
  private pausePlayback(reply: Reply): void {
    reply.pausedAt = this.playedFrames(reply);
    reply.paused = true;
    reply.epoch++;
    reply.markName = undefined;
    reply.written = reply.pausedAt;
    this.opts.session.tapClear();
    this.playbackPeaks = [];
    this.note(`paused at ${reply.pausedAt * 20}ms (caller sound ${this.bargeLoudMs}ms)`);
  }

  /** The sound over us was nothing: pick the sentence back up from just before where we stopped. */
  private resumePlayback(reply: Reply): void {
    // Back up to the last quiet spot (a gap between words) so we do not restart mid-word.
    let from = reply.pausedAt;
    for (let i = reply.pausedAt - 1; i >= Math.max(0, reply.pausedAt - 30); i--) {
      let peak = 0;
      for (const s of mulawDecode(reply.frames[i]!)) peak = Math.max(peak, Math.abs(s));
      if (peak < 500) {
        from = i + 1;
        break;
      }
    }
    reply.paused = false;
    reply.written = from;
    reply.playBaseIndex = from;
    reply.playBaseAt = 0;
    this.note(`resumed from ${from * 20}ms (caller sound was ${this.utteranceLoudMs}ms)`);
    this.writePending(reply);
    if (reply.audioDone) this.markEnd(reply);
    else if (reply.written >= reply.frames.length && reply.playBaseAt === 0) reply.playBaseAt = Date.now();
  }

  private onResponseDone(response: { id?: string; status?: string; status_details?: unknown } | undefined): void {
    const reply = this.active;
    if (!reply || (reply.id && response?.id && reply.id !== response.id)) return;
    this.active = null;
    reply.done = true;
    this.stopWatchdog(reply);
    const status = response?.status ?? 'completed';
    if (reply.utterance && !reply.textDone && !reply.cancelled && status !== 'cancelled') {
      // The reply ended without the usual "text finished" signal: speak what was written.
      this.note(`reply.text ended without a finish signal (${status}): "${reply.text.trim().slice(0, 60)}"`);
      reply.textDone = true;
      reply.utterance.end();
    }

    if (reply.cancelled || status === 'cancelled') {
      // Never heard (or cut off): what was not said must not stay in the model's memory of the call.
      if (!reply.released) this.eraseItems(reply);
    } else if (status === 'failed' || status === 'incomplete') {
      const detail = JSON.stringify(response?.status_details ?? {}).slice(0, 300);
      if (status === 'failed') {
        this.fail(`response failed: ${detail}`);
        return;
      }
      this.note(`model.note response incomplete ${detail}`);
      this.afterGeneration(reply);
    } else {
      this.afterGeneration(reply);
    }

    const next = this.pendingCreate;
    this.pendingCreate = null;
    next?.();
  }

  /** Generation finished normally: act on what the model decided besides speaking. */
  private afterGeneration(reply: Reply): void {
    // With an outside voice the words arrive before their audio does.
    const spoke = reply.frames.length > 0 || (this.opts.tts !== undefined && reply.text.trim().length > 0);
    const toolCalls: FunctionCall[] = [];
    for (const call of reply.calls) {
      if (call.name === 'keep_listening') {
        this.answerCall(call.callId, 'listening');
        if (!spoke) this.hold();
      } else if (call.name === 'end_call') {
        this.answerCall(call.callId, 'ok');
        reply.hangupAfter = true;
      } else if (call.name === 'press_keys') {
        let digits = '';
        try {
          digits = String((JSON.parse(call.args) as { digits?: unknown }).digits ?? '');
        } catch {
          /* malformed arguments: nothing to press */
        }
        digits = digits.replace(/[^0-9A-Da-d*#wW]/g, '').slice(0, 32);
        this.answerCall(call.callId, digits ? 'pressed' : 'no valid keys given');
        if (digits) reply.digitsAfter = digits;
      } else {
        toolCalls.push(call);
      }
    }
    if (toolCalls.length > 0) {
      void this.runTools(toolCalls, spoke);
      return;
    }
    if (!spoke) {
      if (this.waiting === reply) this.waiting = null;
      // (An empty text reply may have opened an utterance with nothing in it.)
      reply.utterance?.cancel();
      if (reply.kind === 'turn' && reply.calls.length === 0 && !this.playing && this.pauseHandled) {
        // The model answered the caller with nothing at all. They are waiting:
        // ask once more, and if it is silent again, say so ourselves.
        if (!reply.afterEmpty) {
          this.note('model returned an empty reply: asking again');
          const retry = this.requestTurnReply();
          if (retry) {
            retry.afterEmpty = true;
            retry.speechEndAt = reply.speechEndAt;
            retry.shortUtterance = reply.shortUtterance;
          }
        } else {
          this.note('model returned an empty reply twice: asking the caller to repeat');
          this.speak('Sorry, could you say that again?');
        }
        return;
      }
      if (reply.hangupAfter && !reply.digitsAfter) {
        // Never hang up on someone without a word.
        this.speak('Goodbye.', { hangupAfter: true });
        return;
      }
      // Nothing to wait for on the line: do the follow-up now.
      if (reply.hangupAfter || reply.digitsAfter) this.afterPlayback(reply);
      else if (!this.holding && !this.playing) this.armSilenceTimer();
    } else if (!reply.released) {
      this.tryRelease(reply);
    }
  }

  private answerCall(callId: string, output: string): void {
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
  }

  /** The model judged the caller to be mid-thought: stay quiet, but not forever. */
  private hold(): void {
    this.holding = true;
    this.note('hold (caller mid-thought)');
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.endHold('hold expired'), this.tuning.holdMaxMs);
    // The model sometimes holds on a plainly finished question. If their words
    // are already in and end in a question, they are waiting for an answer.
    if (this.endsInQuestion(this.turnText)) this.overruleHold();
  }

  private endsInQuestion(text: string): boolean {
    return /\?["')\]]?\s*$/.test(text.trim());
  }

  /** Their words end in a question: answer instead of holding (once per turn). */
  private overruleHold(): void {
    if (!this.holding || this.holdOverruled) return;
    this.holdOverruled = true;
    this.endHold('hold overruled (they asked a question)');
  }

  /** Stop holding and answer what the caller has said so far. */
  private endHold(note: string): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (!this.holding || this.finished) return;
    this.holding = false;
    this.note(note);
    this.addNote('[The caller has finished speaking and is waiting. Respond now to what they said.]');
    this.requestTurnReply();
  }

  // ---------- playback ----------

  /** Twilio has played the reply to its end. */
  private onPlayed(reply: Reply): void {
    this.playing = null;
    this.playbackPeaks = [];
    this.recordAgentTurn(reply, Infinity);
    this.note(`reply.played ${reply.frames.length * 20}ms`);
    // An exchange went by without them needing the extra patience: relax a little.
    this.patienceMs -= (this.patienceMs - this.tuning.patienceMinMs) * 0.15;
    this.clearOverlap();
    this.afterPlayback(reply);
    // Something generated while we were talking (a tool answer) can go out now.
    if (this.waiting) this.tryRelease(this.waiting);
    else if (this.agreedOverAgent && this.pauseHandled && !this.finished && !reply.hangupAfter && !this.toolHoldActive) {
      // They said "yeah" / "okay" while we were talking: now that we have finished, it is their answer.
      this.agreedOverAgent = false;
      this.commitTurn();
      this.requestTurnReply();
    }
  }

  private clearOverlap(): void {
    this.overlap = null;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (this.overlapTimer) clearTimeout(this.overlapTimer);
    if (this.classifyTimer) clearTimeout(this.classifyTimer);
    this.overlapTimer = null;
    this.classifyTimer = null;
  }

  private afterPlayback(reply: Reply): void {
    if (this.finished) return;
    if (reply.digitsAfter) {
      const tones = mulawEncode(generateDtmf(reply.digitsAfter));
      const chunker = new FrameChunker(MULAW_FRAME_BYTES, MULAW_SILENCE);
      for (const frame of chunker.push(tones)) this.opts.session.tapWrite(frame);
      const tail = chunker.flush();
      if (tail) this.opts.session.tapWrite(tail);
      this.turns.push({ role: 'agent', text: `[pressed ${reply.digitsAfter}]` });
      this.note(`pressed ${reply.digitsAfter}`);
    }
    if (reply.hangupAfter) {
      this.note('hangup (agent)');
      void this.opts.session.hangup();
      return;
    }
    if (!this.playing && !this.toolHoldActive) this.armSilenceTimer();
  }

  private recordAgentTurn(reply: Reply, playedMs: number): string {
    let text = (reply.cannedText ?? reply.text).trim();
    const totalMs = reply.frames.length * 20;
    if (text && playedMs < totalMs && totalMs > 0) {
      // Cut off: keep roughly the part that was actually heard.
      const cut = Math.floor(text.length * Math.max(0, playedMs / totalMs));
      const space = text.lastIndexOf(' ', cut);
      text = `${text.slice(0, space > 0 ? space : cut).trim()}…`;
    }
    if (text && text !== '…') this.turns.push({ role: 'agent', text });
    if (reply.kind === 'canned' && reply.cannedText) {
      // Canned lines are spoken outside the conversation; tell the model what it said.
      this.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      });
    }
    return text;
  }

  /** The caller took the floor while we were talking: stop at once. */
  private interrupt(): void {
    const reply = this.playing;
    if (!reply) return;
    const playedMs = this.playedFrames(reply) * 20;
    this.clearOverlap();
    this.agreedOverAgent = false;
    if (!reply.paused) this.opts.session.tapClear();
    reply.epoch++;
    this.playing = null;
    this.playbackPeaks = [];
    reply.hangupAfter = false;
    reply.digitsAfter = undefined;
    if (this.active === reply) this.cancelActive();
    else reply.cancelled = true;
    reply.utterance?.cancel();
    if (reply.kind === 'turn' && reply.audioItemId && !this.opts.tts) {
      this.send({
        type: 'conversation.item.truncate',
        item_id: reply.audioItemId,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.min(playedMs, reply.frames.length * 20)),
      });
    }
    const heard = this.recordAgentTurn(reply, playedMs);
    if (reply.kind === 'turn' && reply.audioItemId && this.opts.tts) {
      // A text reply cannot be truncated in place: replace it with what was heard.
      this.send({ type: 'conversation.item.delete', item_id: reply.audioItemId });
      if (heard && heard !== '…') {
        this.send({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: heard }] },
        });
      }
    }
    this.note(`interrupted after ${playedMs}ms of speech (caller spoke ${this.bargeLoudMs}ms)`);
    if (reply.speechEndAt && playedMs < this.tuning.yieldWindowMs) {
      // We started talking and they simply carried on: we were too quick for this caller.
      const pausedMs = Date.now() - this.bargeLoudMs - reply.speechEndAt;
      this.patienceMs = Math.min(this.tuning.patienceMaxMs, Math.max(this.patienceMs, pausedMs + 150));
      this.note(`patience ${Math.round(this.patienceMs)}ms (we cut in after a ${pausedMs}ms pause)`);
    }
  }

  // ---------- tools ----------

  private async runTools(calls: FunctionCall[], spoke: boolean): Promise<void> {
    if (++this.toolRounds > MAX_TOOL_ROUNDS) {
      for (const call of calls) this.answerCall(call.callId, 'Not run: too many tool calls in one turn.');
      this.speak(CALLBACK_LINE, { hangupAfter: true });
      return;
    }
    this.toolHoldActive = true;
    this.closeTurn();
    this.disarmSilenceTimer();
    if (!spoke) this.speak(HOLD_LINE);
    for (const call of calls) this.opts.onToolRequest?.({ id: call.callId, name: call.name, arguments: call.args });

    const results = new Map<string, string>();
    const reassure = setTimeout(() => {
      if (!this.finished && !this.playing) this.speak(REASSURE_LINE);
    }, REASSURE_AFTER_MS);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => done(), this.opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
      const done = (): void => {
        clearTimeout(timer);
        clearTimeout(reassure);
        for (const call of calls) this.pendingToolWaits.delete(call.callId);
        this.abortToolWait = null;
        resolve();
      };
      this.abortToolWait = done;
      for (const call of calls) {
        this.pendingToolWaits.set(call.callId, (result) => {
          results.set(call.callId, result);
          if (results.size === calls.length) done();
        });
      }
    });
    this.toolHoldActive = false;
    if (this.finished) return;

    const missing = calls.filter((c) => !results.has(c.callId));
    for (const call of calls) {
      this.answerCall(
        call.callId,
        results.get(call.callId) ??
          'Result not available during the call. You promised to handle it right now and call back immediately.',
      );
    }
    if (missing.length > 0) {
      this.opts.onToolTimeout?.(missing.map((m) => m.callId));
      this.speak(CALLBACK_LINE, { hangupAfter: true });
      return;
    }
    this.pendingCallerInput = false;
    this.requestTurnReply();
  }

  // ---------- silence ----------

  private armSilenceTimer(): void {
    const timeoutMs = this.opts.turnTimeoutMs ?? 0;
    if (timeoutMs <= 0 || this.finished || this.toolHoldActive) return;
    this.disarmSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.finished || this.playing || this.active || !this.pauseHandled) return;
      if (++this.unansweredPrompts > MAX_UNANSWERED_PROMPTS) {
        // Nobody is there (a voicemail, a dropped handset): do not keep talking to an empty line.
        this.note(`line silent after ${MAX_UNANSWERED_PROMPTS} prompts: hanging up`);
        this.speak("It sounds like you're not there, so I'll hang up now. Goodbye.", { hangupAfter: true });
        return;
      }
      this.addNote(
        '[The caller has been silent for a while. Briefly restate where things stand toward the objective, or ask the single next question you need. If the objective is done, say goodbye and call end_call.]',
      );
      this.requestTurnReply();
    }, timeoutMs);
  }

  private disarmSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }
}
