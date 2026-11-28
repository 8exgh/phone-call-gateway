import WebSocket from 'ws';
import type { TtsStream, TtsStreamFactory, TtsUtterance } from './ttsStream';

export interface ElevenLabsOptions {
  apiKey: string;
  /** A low-latency model; eleven_flash_v2_5 answers in roughly 0.1-0.2s. */
  model?: string;
  host?: string;
  /** 0.7-1.2; 1 is the voice's natural pace. */
  speed?: number;
}

/**
 * Each piece of text sent is voiced on its own, so where a reply is cut
 * decides how natural it sounds. The first piece is the first whole sentence
 * (or a long opening clause), so speech starts early; everything after it goes
 * as one piece when the reply is complete, unless the reply runs long.
 */
const LONG_REPLY_CHARS = 220;
const MIN_CLAUSE_CHARS = 28;

/**
 * Where the first speakable piece of `text` ends (index just past it), or -1
 * if there is none yet. Sentence ends count; so does a comma after a long
 * enough clause when `clauses` is set. Full stops inside abbreviations
 * ("p.m.", "e.g.", initials) do not.
 */
export function pieceEnd(text: string, clauses: boolean): number {
  const boundary = /([.!?…]["')\]]?|[,;:])\s/g;
  for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
    const mark = match[1]![0]!;
    const at = match.index;
    if (mark === ',' || mark === ';' || mark === ':') {
      if (clauses && at >= MIN_CLAUSE_CHARS) return at + match[1]!.length;
      continue;
    }
    // "p.m." / "a.m." / "e.g." / "J." : a single letter before the stop is an abbreviation,
    // unless the sentence really does end there (next word starts with a capital).
    if (mark === '.' && /(^|[\s.])[A-Za-z]$/.test(text.slice(0, at))) {
      const next = text.slice(at + match[0].length, at + match[0].length + 1);
      if (!next || next === next.toLowerCase()) continue;
    }
    return at + match[1]!.length;
  }
  return -1;
}

/** The slice of a WebSocket this needs (so tests can stand in for the network). */
export interface TtsSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open', handler: () => void): void;
  on(event: 'message', handler: (data: Buffer | string) => void): void;
  on(event: 'close' | 'error', handler: () => void): void;
}
export type TtsSocketConnect = (url: string, headers: Record<string, string>) => TtsSocket;

const DEBUG = Boolean(process.env.ELEVEN_DEBUG);

/**
 * Audio normally starts about 0.2s after text is sent. If nothing has come back
 * after this long, the utterance is sent again on a fresh connection.
 */
const NO_AUDIO_RETRY_MS = 1500;

/** ElevenLabs closes a connection that has more than five utterances in flight; stay under it. */
const MAX_IN_FLIGHT = 4;

interface Line {
  socket: TtsSocket;
  open: boolean;
  dead: boolean;
  queue: string[];
  inFlight: number;
  failure?: string;
}

interface Utterance {
  id: string;
  line: Line;
  onAudio: (mulaw: Uint8Array) => void;
  onDone: () => void;
  onError?: (message: string) => void;
  /** Everything sent for it so far, so it can be said again on a new connection. */
  sent: string[];
  gotAudio: boolean;
  retried: boolean;
  finished: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
}

/**
 * ElevenLabs speech over a warm multi-context WebSocket. Each utterance is a
 * context: closing it stops generation, which is what an interruption needs.
 * Output is raw 8kHz mu-law, ready for the phone line. If a connection is lost
 * before an utterance produced any sound, the utterance is sent again on a
 * fresh one rather than leaving the caller in silence.
 */
class ElevenLabsStream implements TtsStream {
  private line: Line | null = null;
  private closed = false;
  private seq = 0;
  private readonly utterances = new Map<string, Utterance>();
  private lastConnectAt = 0;

  constructor(
    private readonly voiceId: string,
    private readonly opts: ElevenLabsOptions,
    private readonly connectSocket: TtsSocketConnect,
  ) {
    this.line = this.connect();
  }

  private connect(): Line {
    this.lastConnectAt = Date.now();
    const host = this.opts.host ?? 'api.elevenlabs.io';
    const model = this.opts.model ?? 'eleven_flash_v2_5';
    const socket = this.connectSocket(
      `wss://${host}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/multi-stream-input?model_id=${model}&output_format=ulaw_8000&inactivity_timeout=180`,
      { 'xi-api-key': this.opts.apiKey },
    );
    const line: Line = { socket, open: false, dead: false, queue: [], inFlight: 0 };
    socket.on('open', () => {
      line.open = true;
      for (const message of line.queue) socket.send(message);
      line.queue = [];
    });
    socket.on('message', (data: Buffer | string) => {
      let msg: { audio?: string | null; contextId?: string; context_id?: string; isFinal?: boolean; is_final?: boolean; error?: unknown; message?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.error) {
        // Provider errors may have no context ID. Surface them for every
        // affected utterance instead of retrying a policy rejection in silence.
        const failure = `ElevenLabs ${String(msg.error)}: ${msg.message ?? 'speech rejected'}`.replaceAll(this.opts.apiKey, '[redacted]').slice(0, 500);
        const context = msg.contextId ?? msg.context_id;
        if (!context) line.failure = failure;
        for (const u of [...this.utterances.values()]) {
          if (u.line !== line || (context && u.id !== context)) continue;
          u.onError?.(failure);
          this.finish(u);
        }
        return;
      }
      const utterance = this.utterances.get(msg.contextId ?? msg.context_id ?? '');
      if (DEBUG && !msg.audio) console.error(`[eleven ${new Date().toISOString().slice(11, 23)}] <-`, data.toString().slice(0, 240), utterance ? '' : '(no such utterance)');
      if (!utterance || utterance.finished || utterance.line !== line) return;
      if (msg.audio) {
        utterance.gotAudio = true;
        if (utterance.watchdog) clearTimeout(utterance.watchdog);
        utterance.watchdog = null;
        utterance.onAudio(new Uint8Array(Buffer.from(msg.audio, 'base64')));
      }
      if (msg.isFinal || msg.is_final) this.finish(utterance);
    });
    const lost = (): void => {
      if (DEBUG) console.error(`[eleven ${new Date().toISOString().slice(11, 23)}] connection lost (in flight ${line.inFlight}, already dead ${line.dead})`);
      if (line.dead) return;
      line.dead = true;
      line.open = false;
      if (this.line === line) this.line = null;
      // Come back before the next thing needs saying (the provider drops idle connections).
      if (!this.closed && Date.now() - this.lastConnectAt > 5000) {
        const timer = setTimeout(() => {
          if (!this.closed && !this.line) this.line = this.connect();
        }, 1000);
        timer.unref();
      }
      for (const utterance of [...this.utterances.values()]) {
        if (utterance.line !== line || utterance.finished) continue;
        if (!line.failure && !utterance.gotAudio && !utterance.retried && !this.closed) {
          // Nothing was heard yet: say it again on a fresh connection.
          this.resend(utterance);
        } else {
          // Cut off part-way (or failed twice): end it rather than hang the call.
          utterance.onError?.(line.failure ?? 'ElevenLabs speech connection closed before the utterance completed');
          this.finish(utterance);
        }
      }
    };
    socket.on('close', lost);
    socket.on('error', lost);
    return line;
  }

  /** The connection new utterances go to: a fresh one if the current is gone or nearly full. */
  private currentLine(): Line {
    if (!this.line || this.line.dead || this.line.failure || this.line.inFlight >= MAX_IN_FLIGHT) {
      const old = this.line;
      this.line = this.connect();
      // The old connection finishes what it has and is then closed.
      if (old && !old.dead && old.inFlight === 0) old.socket.close();
    }
    return this.line;
  }

  private sendOn(line: Line, message: string): void {
    if (DEBUG) console.error(`[eleven ${new Date().toISOString().slice(11, 23)}] -> ${line.dead ? '(DEAD LINE) ' : line.open ? '' : '(queued) '}${message.slice(0, 160)}`);
    if (line.dead) return;
    if (line.open) line.socket.send(message);
    else line.queue.push(message);
  }

  /** Say an utterance again, from the start, on another connection. */
  private resend(utterance: Utterance): void {
    utterance.retried = true;
    const old = utterance.line;
    old.inFlight = Math.max(0, old.inFlight - 1);
    // Not the connection that just failed to answer.
    if (this.line === old) this.line = null;
    utterance.line = this.currentLine();
    utterance.line.inFlight++;
    for (const message of utterance.sent) this.sendOn(utterance.line, message);
    if (!old.dead && old.inFlight === 0) old.socket.close();
  }

  private finish(utterance: Utterance): void {
    if (utterance.finished) return;
    utterance.finished = true;
    if (utterance.watchdog) clearTimeout(utterance.watchdog);
    utterance.watchdog = null;
    this.utterances.delete(utterance.id);
    const line = utterance.line;
    line.inFlight = Math.max(0, line.inFlight - 1);
    // A connection that has been replaced closes once it has nothing left to say.
    if (line !== this.line && line.inFlight === 0 && !line.dead) line.socket.close();
    utterance.onDone();
  }

  begin(onAudio: (mulaw: Uint8Array) => void, onDone: () => void, onError?: (message: string) => void): TtsUtterance {
    const line = this.currentLine();
    line.inFlight++;
    const utterance: Utterance = { id: `u${++this.seq}`, line, onAudio, onDone, onError, sent: [], gotAudio: false, retried: false, finished: false, watchdog: null };
    this.utterances.set(utterance.id, utterance);
    const send = (payload: Record<string, unknown>): void => {
      const message = JSON.stringify({ ...payload, context_id: utterance.id });
      utterance.sent.push(message);
      this.sendOn(utterance.line, message);
    };
    send({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: this.opts.speed ?? 1 } });
    let held = '';
    let sentAny = false;
    let ended = false;
    const armWatchdog = (): void => {
      if (utterance.watchdog || utterance.gotAudio || utterance.retried) return;
      utterance.watchdog = setTimeout(() => {
        utterance.watchdog = null;
        if (utterance.finished || utterance.gotAudio || utterance.retried || this.closed) return;
        if (DEBUG) console.error(`[eleven] no audio for ${utterance.id} after ${NO_AUDIO_RETRY_MS}ms: sending again on a new connection`);
        this.resend(utterance);
      }, NO_AUDIO_RETRY_MS);
    };
    const flushReady = (): void => {
      // First piece as soon as there is a sentence; after that, hold the rest
      // for one natural delivery unless the reply is running long.
      while (!sentAny || held.length > LONG_REPLY_CHARS) {
        const end = pieceEnd(held, !sentAny);
        if (end < 0) return;
        const piece = held.slice(0, end);
        held = held.slice(end).replace(/^\s+/, '');
        sentAny = true;
        send({ text: `${piece} `, flush: true });
        armWatchdog();
      }
    };
    return {
      push: (text) => {
        if (ended || utterance.finished) return;
        held += text;
        flushReady();
      },
      end: (finalText) => {
        if (ended || utterance.finished) return;
        ended = true;
        if (finalText) held += finalText;
        if (held.trim()) {
          send({ text: `${held.trim()} `, flush: true });
          sentAny = true;
          armWatchdog();
        }
        send({ close_context: true });
        // Nothing to say after all: no audio (and so no final marker) will come.
        if (!sentAny) this.finish(utterance);
      },
      cancel: () => {
        ended = true;
        if (utterance.finished) return;
        // Stop generation; the context frees itself once the provider confirms.
        this.sendOn(utterance.line, JSON.stringify({ context_id: utterance.id, close_context: true }));
        utterance.onAudio = () => {};
        utterance.onDone = () => {};
        utterance.onError = () => {};
        utterance.retried = true;
        if (utterance.watchdog) clearTimeout(utterance.watchdog);
        utterance.watchdog = null;
      },
    };
  }

  close(): void {
    this.closed = true;
    for (const utterance of this.utterances.values()) if (utterance.watchdog) clearTimeout(utterance.watchdog);
    const lines = new Set<Line>();
    if (this.line) lines.add(this.line);
    for (const utterance of this.utterances.values()) lines.add(utterance.line);
    this.utterances.clear();
    for (const line of lines) {
      line.dead = true;
      try {
        line.socket.close();
      } catch {
        /* already closed */
      }
    }
    this.line = null;
  }
}

const wsConnect: TtsSocketConnect = (url, headers) => new WebSocket(url, { headers }) as unknown as TtsSocket;

export function elevenLabsTtsFactory(opts: ElevenLabsOptions, connect: TtsSocketConnect = wsConnect): TtsStreamFactory {
  return (voiceId) => new ElevenLabsStream(voiceId, opts, connect);
}
