import {
  FrameChunker,
  MULAW_FRAME_BYTES,
  toBase64,
  fromBase64,
  pcm16ToBytes,
  bytesToPcm16,
} from '../../src/audio/frames';

describe('frames', () => {
  it('has Twilio frame geometry', () => {
    expect(MULAW_FRAME_BYTES).toBe(160); // 20ms of 8kHz mu-law
  });

  it('base64 round-trips', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('pcm16 byte conversion round-trips little-endian', () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 256]);
    const bytes = pcm16ToBytes(pcm);
    expect(bytes.length).toBe(pcm.length * 2);
    expect(bytes[0]).toBe(0); // LE low byte first
    expect(Array.from(bytesToPcm16(bytes))).toEqual(Array.from(pcm));
  });

  it('bytesToPcm16 drops a trailing odd byte', () => {
    const bytes = new Uint8Array([0x34, 0x12, 0x99]);
    const pcm = bytesToPcm16(bytes);
    expect(Array.from(pcm)).toEqual([0x1234]);
  });

  describe('FrameChunker', () => {
    it('splits a large chunk into full frames plus remainder', () => {
      const chunker = new FrameChunker(4, 0xee);
      const frames = chunker.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
      expect(frames.map((f) => Array.from(f))).toEqual([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ]);
      expect(Array.from(chunker.flush()!)).toEqual([9, 10, 0xee, 0xee]);
    });

    it('accumulates across small pushes', () => {
      const chunker = new FrameChunker(4);
      expect(chunker.push(new Uint8Array([1]))).toEqual([]);
      expect(chunker.push(new Uint8Array([2, 3]))).toEqual([]);
      const frames = chunker.push(new Uint8Array([4, 5]));
      expect(frames.map((f) => Array.from(f))).toEqual([[1, 2, 3, 4]]);
      expect(Array.from(chunker.flush()!)).toEqual([5, 0xff, 0xff, 0xff]);
    });

    it('flush returns null when aligned', () => {
      const chunker = new FrameChunker(2);
      chunker.push(new Uint8Array([1, 2, 3, 4]));
      expect(chunker.flush()).toBeNull();
    });
  });
});
