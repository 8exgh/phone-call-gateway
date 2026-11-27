import type { RealtimeSocketFactory } from './realtimeSocket';

/**
 * Have a realtime voice say one exact line and return the audio as 8kHz
 * mu-law, the same way the agent speaks its greeting. Used for voice previews.
 */
export function renderLine(
  socketFactory: RealtimeSocketFactory,
  model: string,
  voice: string,
  text: string,
  timeoutMs = 20_000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = socketFactory(model);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(new Uint8Array(Buffer.concat(chunks)));
    };
    const timer = setTimeout(() => finish(new Error('voice preview timed out')), timeoutMs);
    socket.onClosed((reason) => finish(new Error(reason)));
    socket.onOpen(() => {
      socket.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: null }, output: { format: { type: 'audio/pcmu' }, voice } },
        },
      });
      socket.send({
        type: 'response.create',
        response: {
          conversation: 'none',
          input: [],
          tool_choice: 'none',
          instructions: `You are a voice on a phone call. Say exactly this, word for word, in a warm natural tone, and nothing else: "${text}"`,
        },
      });
    });
    socket.onEvent((event) => {
      if (event.type === 'response.output_audio.delta') chunks.push(Buffer.from(String(event.delta ?? ''), 'base64'));
      else if (event.type === 'response.done') finish(chunks.length > 0 ? undefined : new Error('voice preview produced no audio'));
      else if (event.type === 'error') {
        const error = (event.error ?? {}) as { message?: string };
        finish(new Error(error.message ?? 'voice preview failed'));
      }
    });
  });
}
