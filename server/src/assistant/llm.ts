import { z } from 'zod';

/**
 * The only model-specific code in the app: an OpenAI-compatible chat-completions boundary.
 * Any provider that speaks this wire format (OpenRouter, OpenAI, a local server) works by
 * changing OPENAI_BASE_URL / LLM_MODEL. Tests replace it with a scripted fake.
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface Completion {
  message: AssistantMessage;
  usage?: { promptTokens: number; completionTokens: number } | undefined;
}

export interface Llm {
  complete(request: CompletionRequest): Promise<Completion>;
}

/** Provider unreachable, timed out, rejected the request, or answered with something unusable. */
export class LlmError extends Error {}

// The provider's response is untrusted input too (OWASP API10): validate before use.
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal('function').default('function'),
                function: z.object({ name: z.string(), arguments: z.string().default('{}') }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

export interface OpenAiCompatibleOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

export class OpenAiCompatibleLlm implements Llm {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async complete({ messages, tools, signal }: CompletionRequest): Promise<Completion> {
    let res: Response;
    try {
      res = await this.fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          tools,
          temperature: 0,
          max_tokens: this.options.maxTokens ?? 800,
        }),
      });
    } catch (err) {
      throw new LlmError(`provider request failed: ${(err as Error).name}`);
    }
    if (!res.ok) throw new LlmError(`provider returned HTTP ${res.status}`);

    const parsed = responseSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new LlmError('provider returned an unexpected response shape');
    const [choice] = parsed.data.choices;
    const toolCalls = choice?.message.tool_calls ?? [];
    const usage = parsed.data.usage;
    return {
      message: {
        role: 'assistant',
        content: choice?.message.content ?? null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      },
      usage: usage
        ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
        : undefined,
    };
  }
}
