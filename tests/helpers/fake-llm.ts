import type {
  AssistantMessage,
  ChatMessage,
  Completion,
  CompletionRequest,
  Llm,
} from '../../server/src/assistant/llm.js';
import { LlmError } from '../../server/src/assistant/llm.js';

type Step = AssistantMessage | LlmError | ((messages: ChatMessage[]) => AssistantMessage);

/**
 * Deterministic stand-in for the model: replays scripted steps in order and records every
 * request, so tests can assert exactly what the model was shown (tool results, history, prompt).
 */
export class FakeLlm implements Llm {
  readonly requests: CompletionRequest[] = [];
  private steps: Step[] = [];

  script(...steps: Step[]): this {
    this.steps = steps;
    this.requests.length = 0;
    return this;
  }

  complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.steps.shift();
    if (step === undefined) return Promise.reject(new Error('FakeLlm: no scripted step left'));
    if (step instanceof LlmError) return Promise.reject(step);
    return Promise.resolve({ message: typeof step === 'function' ? step(request.messages) : step });
  }

  /** Tool messages the model received, parsed back from JSON. */
  toolResults(requestIndex = -1): unknown[] {
    const req = this.requests.at(requestIndex);
    return (req?.messages ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.parse(m.content) as unknown);
  }
}

let callSeq = 0;
export const say = (content: string): AssistantMessage => ({ role: 'assistant', content });
export const callTool = (name: string, args: unknown): AssistantMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: `call_${++callSeq}`,
      type: 'function',
      function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    },
  ],
});
