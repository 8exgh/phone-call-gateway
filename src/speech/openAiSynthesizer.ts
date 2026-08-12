import OpenAI from 'openai';
import { bytesToPcm16 } from '../audio/frames';
import type { SpeechSynthesizer, SynthesizeOptions } from './synthesizer';

/**
 * OpenAI TTS with streamed PCM output: 24kHz 16-bit little-endian mono, which
 * the call session downsamples to 8kHz mu-law for Twilio.
 */
export class OpenAiSpeechSynthesizer implements SpeechSynthesizer {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly defaultVoice: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async *synthesize(text: string, opts: SynthesizeOptions = {}): AsyncIterable<Int16Array> {
    const response = await this.client.audio.speech.create(
      {
        model: this.model,
        voice: (opts.voice ?? this.defaultVoice) as 'alloy',
        input: text,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
        response_format: 'pcm',
      },
      { signal: opts.signal },
    );
    const body = response.body as unknown as AsyncIterable<Uint8Array> | null;
    if (!body) return;

    // Chunk boundaries can split a 16-bit sample; carry the odd byte over.
    let carryByte: number | null = null;
    for await (const chunk of body) {
      let bytes = chunk;
      if (carryByte !== null) {
        const merged = new Uint8Array(bytes.length + 1);
        merged[0] = carryByte;
        merged.set(bytes, 1);
        bytes = merged;
        carryByte = null;
      }
      if (bytes.length % 2 === 1) {
        carryByte = bytes[bytes.length - 1]!;
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (bytes.length > 0) yield bytesToPcm16(bytes);
    }
  }
}
