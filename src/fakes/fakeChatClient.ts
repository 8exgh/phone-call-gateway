import type { ChatClient, ChatMessage } from '../orchestrator/chatClient';

export interface ScriptedReply {
  /** When set, the latest user message must contain this substring. */
  expectUserIncludes?: string;
  reply: string;
}

/** Deterministic LLM for tests and mock-mode demos. */
export class FakeChatClient implements ChatClient {
  readonly receivedUserContents: string[] = [];
  private index = 0;

  constructor(private readonly script: ScriptedReply[]) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    this.receivedUserContents.push(lastUser?.content ?? '');
    const step = this.script[this.index++];
    if (!step) return 'Goodbye now. HANGUP';
    if (step.expectUserIncludes && !(lastUser?.content ?? '').includes(step.expectUserIncludes)) {
      throw new Error(
        `FakeChatClient reply #${this.index}: expected user content to include ` +
          `"${step.expectUserIncludes}" but got "${lastUser?.content ?? ''}"`,
      );
    }
    return step.reply;
  }
}
