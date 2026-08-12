export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatClient {
  /** Return the assistant's next reply for the conversation so far. */
  complete(messages: ChatMessage[]): Promise<string>;
}
