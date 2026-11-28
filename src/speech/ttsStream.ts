/**
 * Streaming text-to-speech for a call: text goes in as the model writes it,
 * 8kHz mu-law audio comes back while later words are still being written.
 * One stream per call and voice; one utterance per thing said.
 */
export interface TtsUtterance {
  /** More text of this utterance, as it is written. */
  push(text: string): void;
  /**
   * Nothing more to say in this utterance. Text given here is spoken as one
   * piece with whatever is still unsent (use it for a line known in full).
   */
  end(finalText?: string): void;
  /** Stop: discard whatever has not been delivered. */
  cancel(): void;
}

export interface TtsStream {
  begin(onAudio: (mulaw: Uint8Array) => void, onDone: () => void, onError?: (message: string) => void): TtsUtterance;
  close(): void;
}

/** voiceId is the provider's own id (without any "provider:" prefix). */
export type TtsStreamFactory = (voiceId: string) => TtsStream;
