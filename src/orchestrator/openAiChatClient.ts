import OpenAI from 'openai';
import type { ChatClient, ChatDelta, ChatMessage, ToolCallRequest, ToolDef } from './chatClient';

function toOpenAiMessages(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.ChatCompletionMessageParam => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export class OpenAiChatClient implements ChatClient {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAiMessages(messages),
    });
    return response.choices[0]?.message?.content ?? '';
  }

  async *streamTurn(messages: ChatMessage[], tools: ToolDef[]): AsyncIterable<ChatDelta> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAiMessages(messages),
      stream: true,
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters ?? { type: 'object', properties: {} },
              },
            })),
          }
        : {}),
    });

    // Tool-call fragments stream by index; accumulate and emit once whole.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    for await (const part of stream) {
      const delta = part.choices[0]?.delta;
      if (delta?.content) yield { text: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const acc = pending.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        pending.set(tc.index, acc);
      }
    }
    if (pending.size > 0) {
      const toolCalls: ToolCallRequest[] = [...pending.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => ({ id: c.id, name: c.name, arguments: c.args || '{}' }));
      yield { toolCalls };
    }
  }
}
