import type { ChatClient, ChatMessage } from '../orchestrator/chatClient';

export interface ScriptedReply {
  /** When set, the latest user message must contain this substring. */
  expectUserIncludes?: string;
  reply: string;
}

/** Replies that pair with defaultCallerScript for mock-mode demos. */
export const demoChatScript: ScriptedReply[] = [
  { reply: 'This is the phone-call-gateway demo agent, just testing the audio pipeline.' },
  { reply: 'I hear you loud and clear — no worries, this is only a local demo. Keeping it short.' },
  { reply: 'Thanks for listening. Have a great day! HANGUP' },
];

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

  /** Streams the scripted reply in ragged chunks, like a real LLM would. */
  async *completeStreaming(messages: ChatMessage[]): AsyncIterable<string> {
    const reply = await this.complete(messages);
    for (let offset = 0; offset < reply.length; offset += 7) {
      yield reply.slice(offset, offset + 7);
    }
  }
}
