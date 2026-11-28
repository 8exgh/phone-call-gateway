import { renderTtsLine } from '../../src/speech/renderTtsLine';
import type { TtsStream, TtsStreamFactory } from '../../src/speech/ttsStream';

describe('phone speech readiness probe', () => {
  it('requires audio and completion, always closes its transport', async () => {
    const close = jest.fn();
    let silent = false;
    const factory: TtsStreamFactory = () => ({
      close,
      begin(audio, done) {
        return { push() {}, cancel() {}, end() { if (!silent) audio(new Uint8Array([1, 2, 3])); done(); } };
      },
    });
    await expect(renderTtsLine(factory, 'voice', 'Hello.')).resolves.toEqual(Buffer.from([1, 2, 3]));
    silent = true;
    await expect(renderTtsLine(factory, 'voice', 'Hello.')).rejects.toThrow('no audio');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('times out and closes a silent or unfinished transport', async () => {
    const close = jest.fn();
    const stream: TtsStream = { close, begin(audio) { audio(new Uint8Array([1])); return { push() {}, end() {}, cancel() {} }; } };
    await expect(renderTtsLine(() => stream, 'voice', 'Hello.', 10)).rejects.toThrow('timed out');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
