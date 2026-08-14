import WebSocket from 'ws';
import { encode as mulawEncode, MULAW_SILENCE } from '../audio/mulaw';
import { toBase64, fromBase64, MULAW_FRAME_BYTES, PCM8K_FRAME_SAMPLES } from '../audio/frames';
import { renderSpeak, type CallerScript, type CallerScriptStep } from './callerScript';

export interface FakeMediaClientOptions {
  url: string;
  providerCallSid: string;
  streamSid: string;
  script: CallerScript;
  /** Real-time ms between 20ms frames. 0 (default) = as fast as the event loop allows. */
  framePacingMs?: number;
}

const SILENCE_FRAME = new Uint8Array(MULAW_FRAME_BYTES).fill(MULAW_SILENCE);

/**
 * Emulates Twilio's side of a bidirectional Media Stream over a real
 * WebSocket: sends connected/start, streams the scripted caller audio as 20ms
 * mu-law media events (with continuous silence frames between utterances, as a
 * real call would), captures outbound audio, acks marks, and honors clear.
 *
 * Playback advances on the media clock like real Twilio: one buffered outbound
 * frame plays per inbound frame tick, and a mark is acked only once every
 * frame received before it has played (clear empties the buffer and flushes
 * pending marks immediately, as documented). The media clock is frame count,
 * so tests still run faster than realtime when framePacingMs is 0.
 */
export class FakeTwilioMediaClient {
  /** Outbound (gateway -> caller) mu-law frames, decoded from base64. */
  readonly capturedOutbound: Uint8Array[] = [];
  clearsReceived = 0;
  marksAcked = 0;

  private readonly ws: WebSocket;
  private readonly script: CallerScriptStep[];
  private readonly framePacingMs: number;
  private pendingAudio: Int16Array | null = null;
  private pendingOffset = 0;
  private framesReceived = 0;
  private framesPlayed = 0;
  private pendingMarkAcks: { name: string; threshold: number }[] = [];
  /** Marks acked that waitForSayCompleted steps have already consumed. */
  private waitsConsumed = 0;
  private stopped = false;
  private loopRunning = false;

  constructor(private readonly opts: FakeMediaClientOptions) {
    this.framePacingMs = opts.framePacingMs ?? 0;
    this.script = [...opts.script];
    this.ws = new WebSocket(opts.url);
    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data: Buffer | string) => this.onMessage(data.toString()));
    this.ws.on('close', () => {
      this.stopped = true;
    });
    this.ws.on('error', () => {
      this.stopped = true;
    });
  }

  /** Abrupt network failure: the socket dies without a stop event. */
  dropConnection(): void {
    this.stopped = true;
    this.ws.terminate();
  }

  /** Caller-side hangup (also used by FakeTwilioApi.hangupCall). */
  endCall(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.send({ event: 'stop', streamSid: this.opts.streamSid });
      this.ws.close();
    }
  }

  get closed(): boolean {
    return this.ws.readyState === WebSocket.CLOSED;
  }

  private onOpen(): void {
    this.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    this.send({
      event: 'start',
      streamSid: this.opts.streamSid,
      start: {
        streamSid: this.opts.streamSid,
        callSid: this.opts.providerCallSid,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    });
    if (!this.loopRunning) {
      this.loopRunning = true;
      void this.runLoop();
    }
  }

  private onMessage(raw: string): void {
    let msg: { event?: string; media?: { payload?: string }; mark?: { name?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.event) {
      case 'media':
        if (typeof msg.media?.payload === 'string') {
          this.capturedOutbound.push(fromBase64(msg.media.payload));
          this.framesReceived++;
        }
        break;
      case 'mark':
        // Ack only once everything received before the mark has played.
        if (typeof msg.mark?.name === 'string') {
          this.pendingMarkAcks.push({ name: msg.mark.name, threshold: this.framesReceived });
          this.ackPlayedMarks();
        }
        break;
      case 'clear':
        this.clearsReceived++;
        // The buffer is emptied and any pending marks come straight back.
        this.framesPlayed = this.framesReceived;
        this.ackPlayedMarks();
        break;
      default:
        break;
    }
  }

  private ackPlayedMarks(): void {
    while (this.pendingMarkAcks.length > 0 && this.pendingMarkAcks[0]!.threshold <= this.framesPlayed) {
      const { name } = this.pendingMarkAcks.shift()!;
      this.marksAcked++;
      this.send({ event: 'mark', streamSid: this.opts.streamSid, mark: { name } });
    }
  }

  private send(payload: object): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped && this.ws.readyState === WebSocket.OPEN) {
      const frame = this.nextFrame();
      if (this.stopped) break; // a hangup step may stop us mid-advance
      this.send({
        event: 'media',
        streamSid: this.opts.streamSid,
        media: { payload: toBase64(frame ?? SILENCE_FRAME) },
      });
      // One inbound frame tick = 20ms of call time = one buffered frame played.
      if (this.framesPlayed < this.framesReceived) {
        this.framesPlayed++;
        this.ackPlayedMarks();
      }
      await this.pace();
    }
  }

  /** The next 20ms of caller audio, advancing the script as needed. */
  private nextFrame(): Uint8Array | null {
    for (;;) {
      if (this.pendingAudio) {
        const remaining = this.pendingAudio.length - this.pendingOffset;
        if (remaining > 0) {
          const take = Math.min(PCM8K_FRAME_SAMPLES, remaining);
          const pcm = this.pendingAudio.subarray(this.pendingOffset, this.pendingOffset + take);
          this.pendingOffset += take;
          if (take < PCM8K_FRAME_SAMPLES) {
            const padded = new Int16Array(PCM8K_FRAME_SAMPLES);
            padded.set(pcm);
            return mulawEncode(padded);
          }
          return mulawEncode(pcm);
        }
        this.pendingAudio = null;
        this.pendingOffset = 0;
      }

      const step = this.script[0];
      if (!step) return null; // script exhausted: idle silence until closed

      if ('speak' in step) {
        this.script.shift();
        // Trailing silence lets VAD and the transcriber endpoint the utterance
        // even if the script author forgot an explicit pause.
        const audio = renderSpeak(step.speak);
        const padded = new Int16Array(audio.length + 500 * 8);
        padded.set(audio);
        this.pendingAudio = padded;
        continue;
      }
      if ('pauseMs' in step) {
        this.script.shift();
        this.pendingAudio = new Int16Array(step.pauseMs * 8);
        continue;
      }
      if ('waitForSayCompleted' in step) {
        if (this.marksAcked > this.waitsConsumed) {
          this.waitsConsumed++;
          this.script.shift();
          continue;
        }
        return null; // keep streaming silence while we wait
      }
      if ('waitForAgentAudioMs' in step) {
        const outboundMs = this.capturedOutbound.reduce((sum, f) => sum + f.length, 0) / 8;
        if (outboundMs >= step.waitForAgentAudioMs) {
          this.script.shift();
          continue;
        }
        return null; // keep streaming silence while we wait
      }
      // hangup
      this.endCall();
      return null;
    }
  }

  private async pace(): Promise<void> {
    if (this.framePacingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.framePacingMs));
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
