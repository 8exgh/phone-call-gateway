import type {
  ChatClient,
  ChatDelta,
  ChatMessage,
  ToolCallRequest,
  ToolDef,
} from '../orchestrator/chatClient';

export interface ScriptedReply {
  /** When set, the latest user message must contain this substring. */
  expectUserIncludes?: string;
  reply: string;
  /** When set, this turn invokes tools (after speaking `reply`, if non-empty). */
  toolCalls?: { name: string; arguments?: string }[];
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
  /** Tool definitions passed on the most recent turn. */
  receivedToolNames: string[] = [];
  /** Every tool-result message ever seen, in order. */
  readonly receivedToolResults: string[] = [];
  private index = 0;
  private callCounter = 0;

  constructor(private readonly script: ScriptedReply[]) {}

  private nextStep(messages: ChatMessage[]): ScriptedReply {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    this.receivedUserContents.push(lastUser?.content ?? '');
    for (const m of messages) {
      if (m.role === 'tool' && !this.receivedToolResults.includes(m.content)) {
        this.receivedToolResults.push(m.content);
      }
    }
    const step = this.script[this.index++];
    if (!step) return { reply: 'Goodbye now. HANGUP' };
    if (step.expectUserIncludes && !(lastUser?.content ?? '').includes(step.expectUserIncludes)) {
      throw new Error(
        `FakeChatClient reply #${this.index}: expected user content to include ` +
          `"${step.expectUserIncludes}" but got "${lastUser?.content ?? ''}"`,
      );
    }
    return step;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    return this.nextStep(messages).reply;
  }

  /** Streams the scripted reply in ragged chunks, like a real LLM would. */
  async *streamTurn(messages: ChatMessage[], tools: ToolDef[]): AsyncIterable<ChatDelta> {
    this.receivedToolNames = tools.map((t) => t.name);
    const step = this.nextStep(messages);
    for (let offset = 0; offset < step.reply.length; offset += 7) {
      yield { text: step.reply.slice(offset, offset + 7) };
    }
    if (step.toolCalls?.length) {
      const toolCalls: ToolCallRequest[] = step.toolCalls.map((c, i) => ({
        id: `call-fake-${++this.callCounter}-${i}`,
        name: c.name,
        arguments: c.arguments ?? '{}',
      }));
      yield { toolCalls };
    }
  }
}
