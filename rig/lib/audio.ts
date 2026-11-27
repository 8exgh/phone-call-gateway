import { writeFileSync, readFileSync } from 'node:fs';

export const RATE = 8000;
export const FRAME = 160; // 20ms at 8kHz

export function rms(pcm: Int16Array, from = 0, to = pcm.length): number {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / (to - from));
}

/** Cut leading and trailing near-silence so a clip's edges are its actual speech edges. */
export function trimSilence(pcm: Int16Array, threshold = 220, padMs = 20): Int16Array {
  const win = RATE / 100; // 10ms
  let first = -1;
  let last = -1;
  for (let i = 0; i + win <= pcm.length; i += win) {
    if (rms(pcm, i, i + win) > threshold) {
      if (first < 0) first = i;
      last = i + win;
    }
  }
  if (first < 0) return pcm;
  const pad = (padMs * RATE) / 1000;
  return pcm.slice(Math.max(0, first - pad), Math.min(pcm.length, last + pad));
}

export function concat(frames: Int16Array[]): Int16Array {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

function wavHeader(dataBytes: number, channels: number, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Stereo WAV: left = caller (what the rig said), right = agent (what the caller heard). */
export function writeWavStereo(path: string, left: Int16Array, right: Int16Array, rate = RATE): void {
  const n = Math.max(left.length, right.length);
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(left[i] ?? 0, i * 4);
    data.writeInt16LE(right[i] ?? 0, i * 4 + 2);
  }
  writeFileSync(path, Buffer.concat([wavHeader(data.length, 2, rate), data]));
}

export function wavMonoBuffer(pcm: Int16Array, rate = RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.concat([wavHeader(data.length, 1, rate), data]);
}

export function readWavStereo(path: string): { left: Int16Array; right: Int16Array } {
  const buf = readFileSync(path);
  const n = (buf.length - 44) / 4;
  const left = new Int16Array(n);
  const right = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = buf.readInt16LE(44 + i * 4);
    right[i] = buf.readInt16LE(44 + i * 4 + 2);
  }
  return { left, right };
}

/** Mix both sides into one mono track (for a listener or an audio judge). */
export function mixMono(a: Int16Array, b: Int16Array): Int16Array {
  const n = Math.max(a.length, b.length);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = (a[i] ?? 0) + (b[i] ?? 0);
    out[i] = Math.max(-32768, Math.min(32767, v));
  }
  return out;
}
