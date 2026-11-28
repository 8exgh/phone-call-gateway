import type { TtsStreamFactory } from './ttsStream';

/** Exercise the actual phone speech transport without dialing a telephone. */
export async function renderTtsLine(factory: TtsStreamFactory, voiceId: string, text: string, timeoutMs = 6000): Promise<Buffer> {
  const stream = factory(voiceId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      timer = setTimeout(() => reject(new Error('speech engine timed out before completing audio')), timeoutMs);
      const utterance = stream.begin(
        (audio) => {
          size += audio.length;
          if (size > 1_000_000) return reject(new Error('speech preview exceeded its size limit'));
          chunks.push(Buffer.from(audio));
        },
        () => size > 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('speech engine produced no audio')),
        (message) => reject(new Error(message)),
      );
      utterance.end(text);
    });
  } finally {
    clearTimeout(timer);
    stream.close();
  }
}
