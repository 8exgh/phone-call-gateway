import WebSocket from 'ws';
import { pcm16ToBytes, toBase64 } from '../audio/frames';
import type { TranscriberCallbacks, TranscriberFactory, TranscriberSession } from './transcriber';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
/** The realtime WS times out at 30 minutes; rotate the connection before that. */
const ROTATE_AFTER_MS = 25 * 60 * 1000;
const MAX_RAPID_RECONNECTS = 3;
const BUFFER_LIMIT_CHUNKS = 500;

/**
 * OpenAI realtime transcription over WebSocket. Audio sent while the socket is
 * (re)connecting is buffered and flushed on open; the connection is proactively
 * rotated before the 30-minute server timeout.
 */
class OpenAiTranscriberSession implements TranscriberSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private buffered: Int16Array[] = [];
  private closed = false;
  private rotateTimer: NodeJS.Timeout | null = null;
  private rapidReconnects = 0;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly language: string,
    private readonly silenceMs: number,
    private readonly callbacks: TranscriberCallbacks,
  ) {
    this.connect();
  }

  private connect(): void {
    const socket = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    this.ws = socket;
    this.ready = false;

    socket.on('open', () => {
      if (this.ws !== socket) return;
      // GA realtime API shape (the beta transcription_session.update was
      // retired with error code beta_api_shape_disabled).
      socket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: {
                  model: this.model,
                  // The language field alone is a weak hint the model drops
                  // on noisy fragments; the prompt reinforces it strongly.
                  ...(this.language
                    ? {
                        language: this.language,
                        prompt: `The speaker is on a phone call in language "${this.language}". Transcribe only in that language; never switch languages.`,
                      }
                    : {}),
                },
                noise_reduction: { type: 'near_field' },
                turn_detection: { type: 'server_vad', silence_duration_ms: this.silenceMs },
              },
            },
          },
        }),
      );
      this.ready = true;
      this.rapidReconnects = 0;
      const pending = this.buffered;
      this.buffered = [];
      for (const pcm of pending) this.sendPcm(pcm);
      this.scheduleRotate();
    });

    socket.on('message', (data: Buffer | string) => {
      if (this.ws === socket) this.onMessage(data.toString());
    });

    socket.on('error', (err: Error) => {
      if (this.ws === socket && !this.closed) this.callbacks.onError(err);
    });

    socket.on('close', () => {
      if (this.ws !== socket || this.closed) return; // stale socket or intentional close
      this.ready = false;
      if (++this.rapidReconnects > MAX_RAPID_RECONNECTS) {
        this.callbacks.onError(new Error('realtime transcription connection keeps dropping'));
        return;
      }
      this.connect();
    });
  }

  private onMessage(raw: string): void {
    let msg: { type?: string; delta?: unknown; transcript?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof msg.delta === 'string' && msg.delta.length > 0) {
          this.callbacks.onDelta(msg.delta);
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof msg.transcript === 'string' && msg.transcript.trim().length > 0) {
          this.callbacks.onCompleted(msg.transcript.trim());
        }
        break;
      case 'error':
        this.callbacks.onError(new Error(msg.error?.message ?? 'realtime transcription error'));
        break;
      default:
        break;
    }
  }

  private scheduleRotate(): void {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.rotateTimer = setTimeout(() => this.rotate(), ROTATE_AFTER_MS);
  }

  private rotate(): void {
    if (this.closed) return;
    const old = this.ws;
    this.ready = false; // buffer audio during the swap
    this.connect();
    old?.close();
  }

  sendAudio(pcm24k: Int16Array): void {
    if (this.closed) return;
    if (this.ready) {
      this.sendPcm(pcm24k);
    } else if (this.buffered.length < BUFFER_LIMIT_CHUNKS) {
      this.buffered.push(pcm24k);
    }
  }

  private sendPcm(pcm: Int16Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: toBase64(pcm16ToBytes(pcm)),
        }),
      );
    }
  }

  close(): void {
    this.closed = true;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.ws?.close();
  }
}

export class OpenAiTranscriberFactory implements TranscriberFactory {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly language: string,
    private readonly silenceMs: number,
  ) {}

  create(callbacks: TranscriberCallbacks): TranscriberSession {
    return new OpenAiTranscriberSession(
      this.apiKey,
      this.model,
      this.language,
      this.silenceMs,
      callbacks,
    );
  }
}
