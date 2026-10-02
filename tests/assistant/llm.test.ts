import { describe, expect, it } from 'vitest';
import { LlmError, OpenAiCompatibleLlm } from '../../server/src/assistant/llm.js';

const signal = new AbortController().signal;
const request = { messages: [{ role: 'user' as const, content: 'hi' }], tools: [], signal };

function client(respond: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const llm = new OpenAiCompatibleLlm({
    apiKey: 'test-key',
    baseUrl: 'https://llm.example/api/v1/',
    model: 'test/model',
    fetch: async (url, init = {}) => {
      calls.push({ url: url as string, init });
      return respond(init);
    },
  });
  return { llm, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('OpenAiCompatibleLlm', () => {
  it('posts a bounded, deterministic request and parses tool calls', async () => {
    const { llm, calls } = client(() =>
      json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'x', arguments: '{"a":1}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    );
    const out = await llm.complete(request);
    expect(out.message.tool_calls?.[0]?.function).toEqual({ name: 'x', arguments: '{"a":1}' });
    expect(out.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
    expect(calls[0]?.url).toBe('https://llm.example/api/v1/chat/completions');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-key',
    );
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({
      model: 'test/model',
      temperature: 0,
      max_tokens: 800,
    });
  });

  it.each([
    ['HTTP error', () => json({ error: 'boom' }, 500)],
    ['non-JSON body', () => new Response('<html>', { status: 200 })],
    ['unexpected shape', () => json({ choices: [] })],
    ['network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('throws LlmError on %s', async (_name, respond) => {
    const { llm } = client(respond);
    await expect(llm.complete(request)).rejects.toBeInstanceOf(LlmError);
  });
});
