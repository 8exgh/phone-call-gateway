/**
 * Twilio Media Streams framing: 20ms of 8kHz mu-law per media event,
 * i.e. 160 bytes per frame, base64-encoded on the wire.
 */

export const FRAME_MS = 20;
export const TELEPHONY_SAMPLE_RATE = 8000;
export const OPENAI_SAMPLE_RATE = 24000;
export const MULAW_FRAME_BYTES = (TELEPHONY_SAMPLE_RATE / 1000) * FRAME_MS; // 160
export const PCM8K_FRAME_SAMPLES = MULAW_FRAME_BYTES;

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  // PCM16 little-endian, which is the native layout on all supported platforms.
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice();
}

export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const aligned = bytes.byteLength % 2 === 0 ? bytes : bytes.subarray(0, bytes.byteLength - 1);
  const copy = aligned.slice();
  return new Int16Array(copy.buffer, 0, copy.byteLength / 2);
}

/**
 * Accumulates arbitrary-size byte chunks and yields fixed-size frames.
 * flush() pads the remainder with the given fill byte to emit a final frame.
 */
export class FrameChunker {
  private buffer: Uint8Array;
  private buffered = 0;

  constructor(
    private readonly frameSize: number = MULAW_FRAME_BYTES,
    private readonly fillByte: number = 0xff,
  ) {
    this.buffer = new Uint8Array(frameSize);
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(this.frameSize - this.buffered, chunk.length - offset);
      this.buffer.set(chunk.subarray(offset, offset + take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === this.frameSize) {
        frames.push(this.buffer.slice());
        this.buffered = 0;
      }
    }
    return frames;
  }

  /** Emit the partial frame (padded), if any. */
  flush(): Uint8Array | null {
    if (this.buffered === 0) return null;
    const frame = new Uint8Array(this.frameSize).fill(this.fillByte);
    frame.set(this.buffer.subarray(0, this.buffered));
    this.buffered = 0;
    return frame;
  }
}
