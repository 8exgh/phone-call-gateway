import type { WebSocket } from 'ws';
import { MediaSocket } from './mediaSocket';
import { ProsodyAnalyzer } from '../prosody/prosodyAnalyzer';
import { decode as mulawDecode, encode as mulawEncode, MULAW_SILENCE } from '../audio/mulaw';
import { StreamingUpsampler8kTo24k, StreamingDownsampler24kTo8k } from '../audio/resample';
import { fromBase64, FrameChunker, MULAW_FRAME_BYTES, TELEPHONY_SAMPLE_RATE } from '../audio/frames';
import type { SpeechSynthesizer } from '../speech/synthesizer';
import type { TranscriberFactory, TranscriberSession } from '../speech/transcriber';
import type { TwilioApi } from '../telephony/twilioApi';
import { generateDtmf } from '../audio/dtmf';
import type {
  CallState,
  ClientMessage,
  SayMessage,
  SendDigitsMessage,
  ServerMessage,
} from '../protocol/messages';

export interface CallSessionDeps {
  synthesizer: SpeechSynthesizer;
  transcriberFactory: TranscriberFactory;
  twilioApi: TwilioApi;
  defaultVoice: string;
}

const EVENT_BUFFER_LIMIT = 1000;

/**
 * Geigel-style double-talk detection: while our audio is playing, inbound
 * sound only counts as caller speech if its peak exceeds this fraction of the
 * loudest recently-played outbound audio. Below that it is treated as line
 * echo of our own voice, which would otherwise trigger false barge-ins that
 * chop our speech mid-word.
 */
const ECHO_SUPPRESSION_RATIO = 0.5;
/** How far back (in 20ms frames) played-audio peaks are considered echo sources. */
const ECHO_LOOKBACK_FRAMES = 40;
/** How far ahead of the playhead estimate to look, absorbing timing jitter. */
const ECHO_LOOKAHEAD_FRAMES = 10;
/**
 * Frames of audio to accumulate before releasing an utterance's first frame,
 * so TTS generation jitter cannot make playback run dry at utterance start.
 * Every frame here is added turn latency, so keep it as small as chop allows.
 */
const PREBUFFER_FRAMES = 10; // 200ms

const SILENT_8K_FRAME = new Int16Array(MULAW_FRAME_BYTES);

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

  private sayQueue: (SayMessage | SendDigitsMessage)[] = [];
  private currentSay: { id: string; abort: AbortController } | null = null;
  private processingSayQueue = false;
  /** markName -> sayId, awaiting Twilio's playback acknowledgement. */
  private pendingMarks = new Map<string, string>();

  /**
   * Peak amplitude of each outbound frame not yet played, drained one entry
   * per inbound frame (both sides run at one frame per 20ms of call time, so
   * the drain position tracks Twilio's playhead).
   */
  private playbackPeaks: number[] = [];
  /** Peaks of recently-played frames: the echo sources to compare against. */
  private recentPlayedPeaks: number[] = [];

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
      case 'sendDigits':
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
      onDtmf: (digit) => this.emit({ type: 'dtmf', digit, atMs: this.mediaClockMs }),
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

  /** True while the inbound frame is judged to be echo of our own playback. */
  private isEchoFrame(inbound: Int16Array): boolean {
    if (this.playbackPeaks.length === 0) {
      this.recentPlayedPeaks = [];
      return false;
    }
    this.recentPlayedPeaks.push(this.playbackPeaks.shift()!);
    if (this.recentPlayedPeaks.length > ECHO_LOOKBACK_FRAMES) this.recentPlayedPeaks.shift();
    let ref = 0;
    for (const p of this.recentPlayedPeaks) ref = Math.max(ref, p);
    const lookahead = Math.min(ECHO_LOOKAHEAD_FRAMES, this.playbackPeaks.length);
    for (let i = 0; i < lookahead; i++) ref = Math.max(ref, this.playbackPeaks[i]!);
    let inboundPeak = 0;
    for (const s of inbound) inboundPeak = Math.max(inboundPeak, Math.abs(s));
    return inboundPeak < ECHO_SUPPRESSION_RATIO * ref;
  }

  private onMediaFrame(payloadB64: string): void {
    const decoded = mulawDecode(fromBase64(payloadB64));
    const frameStartMs = this.mediaClockMs;
    this.mediaClockMs += decoded.length / (TELEPHONY_SAMPLE_RATE / 1000);

    // Echo-judged frames are replaced with silence for both prosody and STT:
    // our own voice reflecting off the line must not read as caller speech.
    const pcm8k = this.isEchoFrame(decoded)
      ? decoded.length === SILENT_8K_FRAME.length
        ? SILENT_8K_FRAME
        : new Int16Array(decoded.length)
      : decoded;

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
    if (this.pendingMarks.size === 0) {
      // Everything sent has played; nothing left to echo.
      this.playbackPeaks = [];
      this.recentPlayedPeaks = [];
    }
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
        const item = this.sayQueue.shift()!;
        if (item.type === 'sendDigits') this.playDigits(item);
        else await this.playSay(item);
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
      // Hold the first PREBUFFER_FRAMES before releasing anything, so a TTS
      // generation stall at utterance start cannot leave playback running dry.
      let prebuffer: Uint8Array[] | null = [];
      const release = (frame: Uint8Array): void => {
        if (prebuffer) {
          prebuffer.push(frame);
          if (prebuffer.length < PREBUFFER_FRAMES) return;
          for (const buffered of prebuffer) this.writeOutboundFrame(buffered);
          prebuffer = null;
          return;
        }
        this.writeOutboundFrame(frame);
      };
      for await (const pcm24k of stream) {
        if (abort.signal.aborted) break;
        const mulawBytes = mulawEncode(downsampler.push(pcm24k));
        if (!started && mulawBytes.length > 0) {
          started = true;
          this.emit({ type: 'say.started', id: say.id });
        }
        for (const frame of chunker.push(mulawBytes)) release(frame);
      }
      if (!abort.signal.aborted) {
        const tail = chunker.flush();
        if (tail) prebuffer?.push(tail);
        if (prebuffer) for (const buffered of prebuffer) this.writeOutboundFrame(buffered);
        if (!prebuffer && tail) this.writeOutboundFrame(tail);
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

  /**
   * Play a DTMF digit string into the call. Rendered in one shot (no TTS
   * stream to await); shares the say lifecycle events, mark tracking, and the
   * echo gate's peak accounting.
   */
  private playDigits(msg: SendDigitsMessage): void {
    const chunker = new FrameChunker(MULAW_FRAME_BYTES, MULAW_SILENCE);
    const mulawBytes = mulawEncode(generateDtmf(msg.digits));
    this.emit({ type: 'say.started', id: msg.id });
    for (const frame of chunker.push(mulawBytes)) this.writeOutboundFrame(frame);
    const tail = chunker.flush();
    if (tail) this.writeOutboundFrame(tail);
    const markName = `say-${msg.id}`;
    this.pendingMarks.set(markName, msg.id);
    this.mediaSocket?.sendMark(markName);
  }

  private writeOutboundFrame(frame: Uint8Array): void {
    let peak = 0;
    for (const s of mulawDecode(frame)) peak = Math.max(peak, Math.abs(s));
    this.playbackPeaks.push(peak);
    this.mediaSocket?.writeMediaFrame(frame);
  }

  private clearSays(reason: 'clear' | 'hangup'): void {
    // Twilio empties its buffer on clear; nothing of ours remains to echo.
    this.playbackPeaks = [];
    this.recentPlayedPeaks = [];
    const abortedIds = new Set<string>();
    if (this.currentSay) {
      abortedIds.add(this.currentSay.id);
      this.currentSay.abort.abort();
      this.currentSay = null;
    }
    for (const queued of this.sayQueue) abortedIds.add(queued.id);
    this.sayQueue = [];
    // Says fully written but still playing out of Twilio's buffer lose their
    // remaining audio to the clear as well; without an aborted event for them
    // the client would wait forever for a say.completed that can never come.
    for (const sayId of this.pendingMarks.values()) abortedIds.add(sayId);
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
