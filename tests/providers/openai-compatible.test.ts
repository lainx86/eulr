import type OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";

import { describe, expect, it, vi } from "vitest";

import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.js";
import type { ModelEvent, ModelRequest } from "../../src/providers/provider.js";

async function* iterable<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) {
    yield value;
  }
}

function chunk(value: Partial<ChatCompletionChunk>): ChatCompletionChunk {
  return {
    id: "chunk-1",
    created: 1,
    model: "test-model",
    object: "chat.completion.chunk",
    choices: [],
    ...value,
  };
}

function request(): ModelRequest {
  return {
    model: "test-model",
    systemPrompt: "System",
    messages: [
      { role: "user", content: "Read it", timestamp: 1 },
      {
        role: "assistant",
        timestamp: 2,
        content: [
          {
            type: "tool_call",
            callId: "old-call",
            toolName: "read",
            arguments: { path: "a.ts" },
          },
        ],
      },
      {
        role: "tool",
        callId: "old-call",
        toolName: "read",
        content: "content",
        isError: false,
        timestamp: 3,
      },
    ],
    tools: [
      {
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object" },
      },
    ],
  };
}

async function collect(
  iterableEvents: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterableEvents) {
    events.push(event);
  }
  return events;
}

describe("OpenAICompatibleProvider", () => {
  it("uses the official SDK and normalizes streaming tool deltas and usage", async () => {
    const create = vi.fn(async (_body: unknown) =>
      iterable([
        chunk({
          choices: [
            { index: 0, delta: { content: "Reading" }, finish_reason: null },
          ],
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "read", arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"b.ts"}' } }],
              },
              finish_reason: null,
            },
          ],
        }),
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
        chunk({
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 3, audio_tokens: 0 },
          },
        }),
      ]),
    );
    const configurations: Array<Record<string, unknown>> = [];
    const fakeClient = {
      chat: { completions: { create } },
      models: { list: () => iterable([]) },
    } as unknown as OpenAI;
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-private",
      baseUrl: "https://compatible.test/v1",
      maxRetries: 0,
      clientFactory: (configuration) => {
        configurations.push(configuration as Record<string, unknown>);
        return fakeClient;
      },
    });

    await expect(collect(provider.stream(request(), {}))).resolves.toEqual([
      { type: "text_delta", text: "Reading" },
      { type: "tool_call_start", callId: "call-1", toolName: "read" },
      { type: "tool_call_delta", callId: "call-1", argumentsDelta: '{"path":' },
      { type: "tool_call_delta", callId: "call-1", argumentsDelta: '"b.ts"}' },
      { type: "tool_call_end", callId: "call-1" },
      {
        type: "usage",
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 3,
      },
      { type: "done", finishReason: "tool_calls" },
    ]);
    expect(configurations).toEqual([
      {
        apiKey: "sk-private",
        baseURL: "https://compatible.test/v1",
        maxRetries: 0,
      },
    ]);
    const sent = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(sent.messages).toEqual([
      { role: "system", content: "System" },
      { role: "user", content: "Read it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "old-call",
            type: "function",
            function: { name: "read", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "old-call", content: "content" },
    ]);
  });

  it("lists models and falls back to the configured model when unsupported", async () => {
    const models = vi.fn(() =>
      iterable([{ id: "z-model" }, { id: "a-model" }]),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: "key",
      model: "fallback",
      clientFactory: () =>
        ({
          models: { list: models },
          chat: { completions: { create: vi.fn() } },
        }) as unknown as OpenAI,
    });
    await expect(provider.listModels()).resolves.toEqual([
      { id: "a-model" },
      { id: "fallback" },
      { id: "z-model" },
    ]);

    const fallback = new OpenAICompatibleProvider({
      apiKey: "key",
      model: "fallback",
      clientFactory: () =>
        ({
          models: {
            list: () => {
              throw Object.assign(new Error("not supported"), { status: 404 });
            },
          },
          chat: { completions: { create: vi.fn() } },
        }) as unknown as OpenAI,
    });
    await expect(fallback.listModels()).resolves.toEqual([{ id: "fallback" }]);
  });

  it("requires a credential and redacts provider errors", async () => {
    const missing = new OpenAICompatibleProvider({
      apiKey: "",
      clientFactory: () => ({}) as OpenAI,
    });
    await expect(collect(missing.stream(request(), {}))).rejects.toThrow(
      "No API key",
    );

    const failing = new OpenAICompatibleProvider({
      apiKey: "sk-private",
      maxRetries: 0,
      clientFactory: () =>
        ({
          models: { list: () => iterable([]) },
          chat: {
            completions: {
              create: vi.fn(async () => {
                throw new Error("Authorization: Bearer sk-private");
              }),
            },
          },
        }) as unknown as OpenAI,
    });
    let message = "";
    try {
      await collect(failing.stream(request(), {}));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("sk-private");

    const unauthorized = new OpenAICompatibleProvider({
      apiKey: "bad-key",
      clientFactory: () =>
        ({
          models: { list: () => iterable([]) },
          chat: {
            completions: {
              create: vi.fn(async () => {
                throw Object.assign(new Error("unauthorized"), { status: 401 });
              }),
            },
          },
        }) as unknown as OpenAI,
    });
    await expect(collect(unauthorized.stream(request(), {}))).rejects.toThrow(
      "Run: eulr auth login",
    );
  });

  it("rejects streams without a finish reason", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "key",
      clientFactory: () =>
        ({
          models: { list: () => iterable([]) },
          chat: {
            completions: {
              create: vi.fn(async () =>
                iterable([
                  chunk({
                    choices: [
                      {
                        index: 0,
                        delta: { content: "partial" },
                        finish_reason: null,
                      },
                    ],
                  }),
                ]),
              ),
            },
          },
        }) as unknown as OpenAI,
    });
    await expect(collect(provider.stream(request(), {}))).rejects.toThrow(
      "without a finish reason",
    );
  });
});
