export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatClient {
  /** Return the assistant's next reply for the conversation so far. */
  complete(messages: ChatMessage[]): Promise<string>;
  /**
   * Optional: stream the reply as text chunks. When present, the orchestrator
   * speaks sentence-by-sentence while the rest is still generating, cutting
   * per-turn latency by the remainder of the LLM's generation time.
   */
  completeStreaming?(messages: ChatMessage[]): AsyncIterable<string>;
}
