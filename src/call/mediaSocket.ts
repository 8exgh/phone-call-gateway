import type { WebSocket } from 'ws';
import { toBase64 } from '../audio/frames';

export interface MediaSocketHandlers {
  onStart(streamSid: string, providerCallSid?: string): void;
  onMedia(payloadB64: string): void;
  onMark(name: string): void;
  onDtmf(digit: string): void;
  onStop(): void;
  onClose(): void;
}

/**
 * Handles one Twilio Media Streams WebSocket connection. Parses incoming
 * events tolerantly (unknown events are ignored) and exposes the outbound
 * side: media frames, marks, and clear.
 */
export class MediaSocket {
  private streamSid: string | null = null;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly handlers: MediaSocketHandlers,
  ) {
    ws.on('message', (data: Buffer | string) => this.handleMessage(data.toString()));
    ws.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.handlers.onClose();
      }
    });
    ws.on('error', () => {
      // The close event follows; nothing to do here.
    });
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const event = (msg as { event?: unknown }).event;
    switch (event) {
      case 'connected':
        break;
      case 'start': {
        const start = (msg as { start?: { streamSid?: unknown; callSid?: unknown } }).start;
        const streamSid = typeof start?.streamSid === 'string' ? start.streamSid : null;
        if (streamSid) {
          this.streamSid = streamSid;
          const callSid = typeof start?.callSid === 'string' ? start.callSid : undefined;
          this.handlers.onStart(streamSid, callSid);
        }
        break;
      }
      case 'media': {
        const payload = (msg as { media?: { payload?: unknown } }).media?.payload;
        if (typeof payload === 'string') this.handlers.onMedia(payload);
        break;
      }
      case 'mark': {
        const name = (msg as { mark?: { name?: unknown } }).mark?.name;
        if (typeof name === 'string') this.handlers.onMark(name);
        break;
      }
      case 'dtmf': {
        const digit = (msg as { dtmf?: { digit?: unknown } }).dtmf?.digit;
        if (typeof digit === 'string' && digit.length === 1) this.handlers.onDtmf(digit);
        break;
      }
      case 'stop':
        this.handlers.onStop();
        break;
      default:
        // Future event types: ignore.
        break;
    }
  }

  private send(payload: object): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  /** Play one mu-law frame into the call. */
  writeMediaFrame(mulawFrame: Uint8Array): void {
    if (!this.streamSid) return;
    this.send({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: toBase64(mulawFrame) },
    });
  }

  /** Twilio acks the mark (as an inbound mark event) once prior audio has played. */
  sendMark(name: string): void {
    if (!this.streamSid) return;
    this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
  }

  /** Flush Twilio's buffered outbound audio (barge-in). */
  sendClear(): void {
    if (!this.streamSid) return;
    this.send({ event: 'clear', streamSid: this.streamSid });
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}
