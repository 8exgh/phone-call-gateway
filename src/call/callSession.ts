import type { WebSocket } from 'ws';
import { MediaSocket } from './mediaSocket';
import { ProsodyAnalyzer } from '../prosody/prosodyAnalyzer';
import { decode as mulawDecode, encode as mulawEncode, MULAW_SILENCE } from '../audio/mulaw';
import { StreamingUpsampler8kTo24k, StreamingDownsampler24kTo8k } from '../audio/resample';
import { fromBase64, FrameChunker, MULAW_FRAME_BYTES, TELEPHONY_SAMPLE_RATE } from '../audio/frames';
import type { SpeechSynthesizer } from '../speech/synthesizer';
import type { TranscriberFactory, TranscriberSession } from '../speech/transcriber';
import type { TwilioApi } from '../telephony/twilioApi';
import type { CallState, ClientMessage, SayMessage, ServerMessage } from '../protocol/messages';

export interface CallSessionDeps {
  synthesizer: SpeechSynthesizer;
  transcriberFactory: TranscriberFactory;
  twilioApi: TwilioApi;
  defaultVoice: string;
}

const EVENT_BUFFER_LIMIT = 1000;

/**
 * State machine for one call, tying together the Twilio media socket, the
 * control socket, TTS, STT, and prosody analysis.
 *
 * created -> dialing -> active -> ending -> ended, with failed reachable from
 * any pre-ended state.
 *
 * The media clock (frames received x frame duration) is the only clock used
 * for prosody timestamps.
 */
export class CallSession {
  private state: CallState = 'created';
  private providerCallSid: string | null = null;
  private mediaSocket: MediaSocket | null = null;
  private controlSend: ((msg: ServerMessage) => void) | null = null;
  private eventBuffer: ServerMessage[] = [];

  private readonly analyzer = new ProsodyAnalyzer();
  private readonly inboundUpsampler = new StreamingUpsampler8kTo24k();
  private mediaClockMs = 0;

  private transcriber: TranscriberSession | null = null;
  private transcriberPending = false;
  private pendingTranscriberAudio: Int16Array[] = [];

  private sayQueue: SayMessage[] = [];
  private currentSay: { id: string; abort: AbortController } | null = null;
  private processingSayQueue = false;
  /** markName -> sayId, awaiting Twilio's playback acknowledgement. */
  private pendingMarks = new Map<string, string>();

  constructor(
    readonly callId: string,
    private readonly deps: CallSessionDeps,
  ) {}

  get currentState(): CallState {
    return this.state;
  }

  // ---------- lifecycle ----------

  setDialing(providerCallSid: string): void {
    this.providerCallSid = providerCallSid;
    this.setState('dialing');
  }

  fail(reason: string): void {
    if (this.state === 'ended' || this.state === 'failed') return;
    this.teardown();
    this.setState('failed', reason);
  }

  private setState(state: CallState, reason?: string): void {
    this.state = state;
    this.emit({ type: 'call.state', callId: this.callId, state, ...(reason ? { reason } : {}) });
  }

  private teardown(): void {
    void this.transcriber?.close();
    this.transcriber = null;
    if (this.currentSay) this.currentSay.abort.abort();
    this.sayQueue = [];
    this.pendingMarks.clear();
  }

  // ---------- control socket ----------

  /** Returns false if another control client is already attached. */
  attachControl(send: (msg: ServerMessage) => void): boolean {
    if (this.controlSend) return false;
    this.controlSend = send;
    const buffered = this.eventBuffer;
    this.eventBuffer = [];
    for (const msg of buffered) send(msg);
    if (!buffered.some((m) => m.type === 'call.state')) {
      send({ type: 'call.state', callId: this.callId, state: this.state });
    }
    return true;
  }

  detachControl(): void {
    this.controlSend = null;
  }

  handleControlMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case 'say':
        if (this.state === 'ending' || this.state === 'ended' || this.state === 'failed') {
          this.emit({ type: 'error', code: 'call_failed', message: `call is ${this.state}` });
          return;
        }
        this.sayQueue.push(msg);
        void this.processSayQueue();
        break;
      case 'clear':
        this.clearSays('clear');
        break;
      case 'hangup':
        void this.hangup();
        break;
    }
  }

  private emit(msg: ServerMessage): void {
    if (this.controlSend) {
      this.controlSend(msg);
    } else if (this.eventBuffer.length < EVENT_BUFFER_LIMIT) {
      this.eventBuffer.push(msg);
    }
  }

  // ---------- media socket ----------

  attachMediaWs(ws: WebSocket): void {
    this.mediaSocket = new MediaSocket(ws, {
      onStart: (_streamSid, providerCallSid) => this.onMediaStart(providerCallSid),
      onMedia: (payloadB64) => this.onMediaFrame(payloadB64),
      onMark: (name) => this.onMediaMark(name),
      onStop: () => this.onMediaStop(),
      onClose: () => this.onMediaClose(),
    });
  }

  private onMediaStart(providerCallSid?: string): void {
    if (providerCallSid) this.providerCallSid = providerCallSid;
    if (this.state === 'created' || this.state === 'dialing') {
      this.setState('active');
    }
    void this.initTranscriber();
    void this.processSayQueue();
  }

  private async initTranscriber(): Promise<void> {
    if (this.transcriber || this.transcriberPending) return;
    this.transcriberPending = true;
    try {
      this.transcriber = await this.deps.transcriberFactory.create({
        onDelta: (text) => this.emit({ type: 'transcript.delta', text }),
        onCompleted: (text, confidence) => {
          const annotation = this.analyzer.annotate(text, confidence);
          this.emit({ type: 'transcript', ...annotation });
        },
        onError: (error) => this.emit({ type: 'error', code: 'stt_failed', message: error.message }),
      });
      for (const pcm of this.pendingTranscriberAudio) this.transcriber.sendAudio(pcm);
      this.pendingTranscriberAudio = [];
    } catch (error) {
      this.emit({
        type: 'error',
        code: 'stt_failed',
        message: `transcriber init failed: ${(error as Error).message}`,
      });
    } finally {
      this.transcriberPending = false;
    }
  }

  private onMediaFrame(payloadB64: string): void {
    const pcm8k = mulawDecode(fromBase64(payloadB64));
    const frameStartMs = this.mediaClockMs;
    this.mediaClockMs += pcm8k.length / (TELEPHONY_SAMPLE_RATE / 1000);

    for (const event of this.analyzer.pushFrame(pcm8k, frameStartMs)) {
      this.emit(
        event.type === 'speech.started'
          ? { type: 'speech.started', atMs: event.atMs }
          : { type: 'speech.stopped', atMs: event.atMs },
      );
    }

    const pcm24k = this.inboundUpsampler.push(pcm8k);
    if (this.transcriber) {
      this.transcriber.sendAudio(pcm24k);
    } else if (this.pendingTranscriberAudio.length < 500) {
      this.pendingTranscriberAudio.push(pcm24k);
    }
  }

  private onMediaMark(name: string): void {
    const sayId = this.pendingMarks.get(name);
    if (sayId === undefined) return;
    this.pendingMarks.delete(name);
    this.emit({ type: 'say.completed', id: sayId });
  }

  private onMediaStop(): void {
    if (this.state === 'ended' || this.state === 'failed') return;
    this.teardown();
    this.setState('ended', this.state === 'ending' ? 'hangup' : 'remote_hangup');
  }

  private onMediaClose(): void {
    if (this.state === 'ended' || this.state === 'failed') return;
    this.teardown();
    this.setState('failed', 'media_disconnected');
  }

  // ---------- say pipeline ----------

  private async processSayQueue(): Promise<void> {
    if (this.processingSayQueue) return;
    this.processingSayQueue = true;
    try {
      while (this.sayQueue.length > 0 && this.state === 'active' && this.mediaSocket) {
        const say = this.sayQueue.shift()!;
        await this.playSay(say);
      }
    } finally {
      this.processingSayQueue = false;
    }
  }

  private async playSay(say: SayMessage): Promise<void> {
    const abort = new AbortController();
    this.currentSay = { id: say.id, abort };
    try {
      const stream = this.deps.synthesizer.synthesize(say.text, {
        voice: say.voice ?? this.deps.defaultVoice,
        instructions: say.instructions,
        signal: abort.signal,
      });
      const chunker = new FrameChunker(MULAW_FRAME_BYTES, MULAW_SILENCE);
      // Streaming decimator carries filter state across the arbitrary-size
      // 24kHz chunks, so there are no seams between them.
      const downsampler = new StreamingDownsampler24kTo8k();
      let started = false;
      for await (const pcm24k of stream) {
        if (abort.signal.aborted) break;
        const mulawBytes = mulawEncode(downsampler.push(pcm24k));
        if (!started && mulawBytes.length > 0) {
          started = true;
          this.emit({ type: 'say.started', id: say.id });
        }
        for (const frame of chunker.push(mulawBytes)) {
          this.mediaSocket?.writeMediaFrame(frame);
        }
      }
      if (!abort.signal.aborted) {
        const tail = chunker.flush();
        if (tail) this.mediaSocket?.writeMediaFrame(tail);
        if (!started) this.emit({ type: 'say.started', id: say.id });
        const markName = `say-${say.id}`;
        this.pendingMarks.set(markName, say.id);
        this.mediaSocket?.sendMark(markName);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.emit({ type: 'error', code: 'tts_failed', message: (error as Error).message });
        this.emit({ type: 'say.aborted', id: say.id, reason: 'error' });
      }
    } finally {
      this.currentSay = null;
    }
  }

  private clearSays(reason: 'clear' | 'hangup'): void {
    const abortedIds: string[] = [];
    if (this.currentSay) {
      abortedIds.push(this.currentSay.id);
      this.currentSay.abort.abort();
      this.currentSay = null;
    }
    for (const queued of this.sayQueue) abortedIds.push(queued.id);
    this.sayQueue = [];
    this.pendingMarks.clear();
    this.mediaSocket?.sendClear();
    for (const id of abortedIds) {
      this.emit({ type: 'say.aborted', id, reason });
    }
  }

  // ---------- hangup ----------

  async hangup(): Promise<void> {
    if (this.state === 'ending' || this.state === 'ended' || this.state === 'failed') return;
    this.clearSays('hangup');
    this.setState('ending');
    if (this.providerCallSid) {
      try {
        await this.deps.twilioApi.hangupCall(this.providerCallSid);
      } catch {
        // If the hangup API call fails the media socket close will still
        // terminate the session; nothing useful to surface here.
      }
    }
    if (!this.mediaSocket) {
      // Call never got a media connection (e.g. still dialing): end directly.
      this.teardown();
      this.setState('ended', 'hangup');
    }
  }
}
