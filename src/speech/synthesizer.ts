export interface SynthesizeOptions {
  voice?: string;
  /** Style/tone control, e.g. "speak warmly, at a relaxed pace". */
  instructions?: string;
  signal?: AbortSignal;
}

export interface SpeechSynthesizer {
  /** Yields 24kHz mono PCM16 chunks as they are generated. */
  synthesize(text: string, opts?: SynthesizeOptions): AsyncIterable<Int16Array>;
}
