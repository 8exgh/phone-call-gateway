export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments; defaults to an empty object schema. */
  parameters?: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON argument string, exactly as the model produced it. */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant messages that invoked tools. */
  toolCalls?: ToolCallRequest[];
  /** Present on tool messages: which call this result answers. */
  toolCallId?: string;
}

/** Streaming chunk: reply text as it generates, tool calls once complete. */
export type ChatDelta = { text: string } | { toolCalls: ToolCallRequest[] };

export interface ChatClient {
  /** Return the assistant's next reply (no tools). Fallback path. */
  complete(messages: ChatMessage[]): Promise<string>;
  /**
   * Preferred: stream the reply as text chunks; when the model decides to
   * invoke tools instead of (or after) speaking, a final {toolCalls} chunk
   * carries them. Enables sentence-by-sentence speech and mid-call tools.
   */
  streamTurn?(messages: ChatMessage[], tools: ToolDef[]): AsyncIterable<ChatDelta>;
}
