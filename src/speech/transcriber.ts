export interface TranscriberCallbacks {
  /** Low-latency partial text for the current utterance. */
  onDelta(text: string): void;
  /** A finished utterance segment. */
  onCompleted(text: string, confidence?: number): void;
  onError(error: Error): void;
}

export interface TranscriberSession {
  /** Feed 24kHz mono PCM16 audio. */
  sendAudio(pcm24k: Int16Array): void;
  close(): void | Promise<void>;
}

export interface TranscriberFactory {
  /** One session per call. */
  create(callbacks: TranscriberCallbacks): TranscriberSession | Promise<TranscriberSession>;
}
