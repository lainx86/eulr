import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentLoop } from "../../src/agent/loop.js";
import type { ChatGPTCredential } from "../../src/auth/types.js";
import type { AgentMessage } from "../../src/agent/messages.js";
import {
  CODEX_PROTOCOL_COMPATIBILITY_VERSION,
  OpenAICodexProvider,
} from "../../src/providers/openai-codex.js";
import type { ChatGPTCredentialSource } from "../../src/providers/openai-codex.js";
import type { ModelEvent, ModelRequest } from "../../src/providers/provider.js";
import type { PermissionChecker } from "../../src/permissions/types.js";
import { SessionService } from "../../src/sessions/session-service.js";
import { SessionStore } from "../../src/sessions/store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { AuthenticationError, ProviderError } from "../../src/utils/errors.js";

function credential(accessToken = "access-token"): ChatGPTCredential {
  return {
    accessToken,
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
    accountId: "account-1",
  };
}

function fakeAuth(): ChatGPTCredentialSource & {
  getValidChatGPTCredential: ReturnType<typeof vi.fn>;
  forceRefreshChatGPT: ReturnType<typeof vi.fn>;
} {
  return {
    getValidChatGPTCredential: vi.fn(async () => credential("old-token")),
    forceRefreshChatGPT: vi.fn(async () => credential("new-token")),
  };
}

function sseResponse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function completedResponse(): Response {
  return sseResponse([
    {
      type: "response.completed",
      response: {
        end_turn: true,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
  ]);
}

async function collect(
  iterable: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function request(messages: AgentMessage[] = []): ModelRequest {
  return {
    model: "gpt-test",
    systemPrompt: "Work carefully.",
    messages,
    tools: [
      {
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    sessionId: "session-1",
  };
}

describe("OpenAICodexProvider", () => {
  it("round-trips encrypted reasoning before its tool call on the next turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "eulr-reasoning-roundtrip-"));
    try {
      const bodies: Record<string, unknown>[] = [];
      let turn = 0;
      const reasoningItem = {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Need to inspect" }],
        encrypted_content: "opaque-reasoning-ciphertext",
      };
      const provider = new OpenAICodexProvider({
        auth: fakeAuth(),
        fetch: (async (_input, init) => {
          bodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          turn += 1;
          if (turn === 1) {
            return sseResponse([
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "reasoning", id: "rs_1", summary: [] },
              },
              {
                type: "response.reasoning_summary_text.delta",
                output_index: 0,
                delta: "Need to inspect",
              },
              {
                type: "response.output_item.added",
                output_index: 1,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "read",
                },
              },
              {
                type: "response.function_call_arguments.delta",
                item_id: "fc_1",
                delta: '{"path":"src/a.ts"}',
              },
              {
                type: "response.output_item.done",
                output_index: 1,
                item: {
                  type: "function_call",
                  call_id: "call_1",
                  name: "read",
                  arguments: '{"path":"src/a.ts"}',
                },
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: reasoningItem,
              },
              {
                type: "response.completed",
                response: { end_turn: false },
              },
            ]);
          }
          return sseResponse([
            {
              type: "response.output_text.delta",
              output_index: 0,
              delta: "Done.",
            },
            {
              type: "response.completed",
              response: { end_turn: true },
            },
          ]);
        }) as typeof fetch,
      });
      const sessions = new SessionService(
        new SessionStore({ directory: join(root, "sessions") }),
      );
      const session = await sessions.create({
        id: "roundtrip-test",
        cwd: root,
        provider: provider.id,
        model: "gpt-test",
      });
      const loop = new AgentLoop({
        provider,
        model: "gpt-test",
        tools: new ToolRegistry(),
        permissions: {
          check: async () => true,
        } satisfies PermissionChecker,
        sessions,
      });

      const result = await loop.runTask(session, "Inspect it");

      expect(result.finalText).toBe("Done.");
      expect(bodies).toHaveLength(2);
      expect(bodies[1]?.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect it" }],
        },
        reasoningItem,
        {
          type: "function_call",
          call_id: "call_1",
          name: "read",
          arguments: '{"path":"src/a.ts"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: expect.stringContaining("Unknown tool: read"),
        },
      ]);
      expect(
        result.session.messages.filter(
          (message) => message.role === "assistant",
        )[0]?.content,
      ).toContainEqual({
        type: "provider_item",
        providerId: "openai-codex",
        data: reasoningItem,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes text, reasoning, tool calls, usage, and completion", async () => {
    const auth = fakeAuth();
    let sentBody: Record<string, unknown> | undefined;
    let sentHeaders: Headers | undefined;
    const provider = new OpenAICodexProvider({
      auth,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        sentHeaders = new Headers(init?.headers);
        return sseResponse([
          { type: "response.output_text.delta", delta: "Working" },
          {
            type: "response.reasoning_summary_text.delta",
            delta: "Inspecting",
          },
          {
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "item-1",
              call_id: "call-1",
              name: "read",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-1",
            delta: '{"path":',
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-1",
            delta: '"src/a.ts"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call-1",
              name: "read",
              arguments: '{"path":"src/a.ts"}',
            },
          },
          {
            type: "response.completed",
            response: {
              end_turn: false,
              usage: {
                input_tokens: 20,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 7 },
              },
            },
          },
        ]);
      }) as typeof fetch,
    });
    const messages: AgentMessage[] = [
      { role: "user", content: "Fix it", timestamp: 1 },
      {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "text", text: "I will inspect." },
          {
            type: "tool_call",
            callId: "old-call",
            toolName: "read",
            arguments: { path: "old.ts" },
          },
        ],
      },
      {
        role: "tool",
        callId: "old-call",
        toolName: "read",
        content: "old content",
        isError: false,
        timestamp: 3,
      },
    ];

    const modelRequest = request(messages);
    modelRequest.reasoningEffort = "high";
    await expect(collect(provider.stream(modelRequest, {}))).resolves.toEqual([
      { type: "text_delta", text: "Working" },
      { type: "reasoning_delta", text: "Inspecting" },
      { type: "tool_call_start", callId: "call-1", toolName: "read" },
      { type: "tool_call_delta", callId: "call-1", argumentsDelta: '{"path":' },
      {
        type: "tool_call_delta",
        callId: "call-1",
        argumentsDelta: '"src/a.ts"}',
      },
      { type: "tool_call_end", callId: "call-1" },
      {
        type: "usage",
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 7,
      },
      { type: "done", finishReason: "tool_calls" },
    ]);
    expect(sentHeaders?.get("authorization")).toBe("Bearer old-token");
    expect(sentHeaders?.get("chatgpt-account-id")).toBe("account-1");
    expect(sentHeaders?.get("originator")).toBe("eulr");
    expect(sentHeaders?.get("session-id")).toBe("session-1");
    expect(sentBody).toMatchObject({
      model: "gpt-test",
      reasoning: { effort: "high", summary: "auto" },
      instructions: "Work carefully.",
      stream: true,
      store: false,
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          name: "read",
          strict: false,
        },
      ],
    });
    expect(sentBody?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix it" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I will inspect." }],
      },
      {
        type: "function_call",
        call_id: "old-call",
        name: "read",
        arguments: '{"path":"old.ts"}',
      },
      {
        type: "function_call_output",
        call_id: "old-call",
        output: "old content",
      },
    ]);
  });

  it("uses the authenticated remote model catalog and priority order", async () => {
    const auth = fakeAuth();
    let requestedUrl = "";
    const provider = new OpenAICodexProvider({
      auth,
      protocolCompatibilityVersion: "1.2.3",
      fetch: (async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            models: [
              {
                slug: "hidden",
                display_name: "Hidden",
                visibility: "hide",
                minimal_client_version: "0.1.0",
                priority: 0,
              },
              {
                slug: "second",
                display_name: "Second",
                visibility: "list",
                minimal_client_version: "0.1.0",
                priority: 2,
              },
              {
                slug: "first",
                display_name: "First",
                description: "Preferred",
                context_window: 272000,
                default_reasoning_level: "medium",
                supported_reasoning_levels: [
                  { effort: "low", description: "Fast" },
                  { effort: "medium", description: "Balanced" },
                  { effort: "high", description: "Deep" },
                ],
                visibility: "list",
                minimal_client_version: "0.1.0",
                priority: 1,
              },
            ],
          }),
        );
      }) as typeof fetch,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "first",
        name: "First",
        description: "Preferred",
        contextWindow: 272000,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { effort: "low", description: "Fast" },
          { effort: "medium", description: "Balanced" },
          { effort: "high", description: "Deep" },
        ],
      },
      { id: "second", name: "Second" },
    ]);
    expect(requestedUrl).toContain("/models?client_version=1.2.3");
  });

  it("maps the Codex Ultra UI preset to Max on the Responses wire", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      fetch: (async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return completedResponse();
      }) as typeof fetch,
    });
    const modelRequest = request();
    modelRequest.reasoningEffort = "ultra";

    await collect(provider.stream(modelRequest, {}));

    expect(sentBody?.reasoning).toEqual({ effort: "max", summary: "auto" });
  });

  it("uses the pinned Codex protocol compatibility version, not the eulr version", async () => {
    let requestedUrl: URL | undefined;
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      fetch: (async (input) => {
        requestedUrl = new URL(String(input));
        return new Response(JSON.stringify({ models: [] }));
      }) as typeof fetch,
    });

    await provider.listModels();

    expect(CODEX_PROTOCOL_COMPATIBILITY_VERSION).toBe("0.144.4");
    expect(requestedUrl?.searchParams.get("client_version")).toBe(
      CODEX_PROTOCOL_COMPATIBILITY_VERSION,
    );
    expect(requestedUrl?.searchParams.get("client_version")).not.toBe("0.1.0");
  });

  it("parses top-level models, maps slugs, filters visibility and minimum version, and sorts by priority", async () => {
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      fetch: (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "hidden",
                display_name: "Hidden",
                visibility: "hide",
                minimal_client_version: "0.1.0",
                priority: 0,
              },
              {
                slug: "legacy-compatible",
                display_name: "Legacy Compatible",
                visibility: "list",
                minimal_client_version: "0.98.0",
                priority: 2,
              },
              {
                slug: "current-compatible",
                display_name: "Current Compatible",
                description: "Current catalog entry",
                context_window: 372_000,
                visibility: "list",
                minimal_client_version: CODEX_PROTOCOL_COMPATIBILITY_VERSION,
                priority: 1,
              },
              {
                slug: "future-client-only",
                display_name: "Future Client Only",
                visibility: "list",
                minimal_client_version: "0.144.5",
                priority: 3,
              },
            ],
          }),
        )) as typeof fetch,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "current-compatible",
        name: "Current Compatible",
        description: "Current catalog entry",
        contextWindow: 372_000,
      },
      { id: "legacy-compatible", name: "Legacy Compatible" },
    ]);
  });

  it("retains the visible GPT-5.6 models from the pinned upstream catalog", async () => {
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      fetch: (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-5.6-sol",
                display_name: "GPT-5.6-Sol",
                visibility: "list",
                minimal_client_version: "0.144.0",
                priority: 1,
              },
              {
                slug: "gpt-5.6-terra",
                display_name: "GPT-5.6-Terra",
                visibility: "list",
                minimal_client_version: "0.144.0",
                priority: 2,
              },
              {
                slug: "gpt-5.6-luna",
                display_name: "GPT-5.6-Luna",
                visibility: "list",
                minimal_client_version: "0.144.0",
                priority: 3,
              },
            ],
          }),
        )) as typeof fetch,
    });

    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("rejects a malformed catalog explicitly instead of returning no models", async () => {
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      fetch: (async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("HTTP 200"),
    });
  });

  it("reports HTTP catalog failures with a sanitized response summary", async () => {
    const secretAccessToken = "catalog.access.token";
    const secretRefreshToken = "catalog-refresh-secret";
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      maxAttempts: 1,
      fetch: (async () =>
        new Response(
          `upstream failure Authorization: Bearer ${secretAccessToken} refresh_token=${secretRefreshToken}`,
          { status: 502 },
        )) as typeof fetch,
    });

    let failure: unknown;
    try {
      await provider.listModels();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProviderError);
    const message =
      failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("HTTP 502");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(secretAccessToken);
    expect(message).not.toContain(secretRefreshToken);
  });

  it("preserves the last successful catalog when a refresh fails", async () => {
    const warnings: string[] = [];
    let requestCount = 0;
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      maxAttempts: 1,
      onWarning: (warning) => warnings.push(warning),
      fetch: (async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  slug: "cached-model",
                  display_name: "Cached Model",
                  visibility: "list",
                  minimal_client_version: "0.1.0",
                  priority: 1,
                },
              ],
            }),
          );
        }
        return new Response(
          "temporary failure Authorization: Bearer should-not-leak",
          { status: 503 },
        );
      }) as typeof fetch,
    });

    const initial = await provider.listModels();
    const cached = await provider.listModels();

    expect(initial).toEqual([{ id: "cached-model", name: "Cached Model" }]);
    expect(cached).toEqual(initial);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cached/i);
    expect(warnings[0]).toContain("HTTP 503");
    expect(warnings[0]).not.toContain("should-not-leak");
  });

  it("keeps a configured model usable when the initial catalog request fails", async () => {
    const warnings: string[] = [];
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      configuredModel: "gpt-explicit",
      maxAttempts: 1,
      onWarning: (warning) => warnings.push(warning),
      fetch: (async () =>
        new Response("catalog service unavailable", {
          status: 503,
        })) as typeof fetch,
    });

    await expect(provider.listModels()).resolves.toEqual([
      { id: "gpt-explicit" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/configured/i);
    expect(warnings[0]).toContain("gpt-explicit");
    expect(warnings[0]).toContain("HTTP 503");
  });

  it("does not replace an authentication failure with a configured model", async () => {
    const warnings: string[] = [];
    const auth: ChatGPTCredentialSource = {
      getValidChatGPTCredential: vi.fn(async () => {
        throw new AuthenticationError(
          "Select a ChatGPT account and log in again",
        );
      }),
      forceRefreshChatGPT: vi.fn(async () => credential()),
    };
    const provider = new OpenAICodexProvider({
      auth,
      configuredModel: "gpt-explicit",
      onWarning: (warning) => warnings.push(warning),
      fetch: vi.fn() as unknown as typeof fetch,
    });

    await expect(provider.listModels()).rejects.toThrow(
      "Select a ChatGPT account",
    );
    expect(warnings).toEqual([]);
  });

  it("does not replace a token refresh failure with a configured model", async () => {
    const warnings: string[] = [];
    const auth: ChatGPTCredentialSource = {
      getValidChatGPTCredential: vi.fn(async () => credential("expired-token")),
      forceRefreshChatGPT: vi.fn(async () => {
        throw new AuthenticationError(
          "ChatGPT token refresh failed; run: eulr auth login",
        );
      }),
    };
    const provider = new OpenAICodexProvider({
      auth,
      configuredModel: "gpt-explicit",
      maxAttempts: 1,
      onWarning: (warning) => warnings.push(warning),
      fetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
    });

    await expect(provider.listModels()).rejects.toThrow("token refresh failed");
    expect(auth.forceRefreshChatGPT).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });

  it("refreshes once after 401 and retries bounded 5xx failures", async () => {
    const auth = fakeAuth();
    let calls = 0;
    const delays: number[] = [];
    const provider = new OpenAICodexProvider({
      auth,
      retryBaseDelayMs: 10,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      fetch: (async (_input, init) => {
        calls += 1;
        const authorization = new Headers(init?.headers).get("authorization");
        if (calls === 1) {
          expect(authorization).toBe("Bearer old-token");
          return new Response(null, { status: 401 });
        }
        if (calls === 2) {
          expect(authorization).toBe("Bearer new-token");
          return new Response(null, { status: 503 });
        }
        return completedResponse();
      }) as typeof fetch,
    });

    await expect(
      collect(provider.stream(request(), {})),
    ).resolves.toContainEqual({
      type: "done",
      finishReason: "stop",
    });
    expect(auth.forceRefreshChatGPT).toHaveBeenCalledOnce();
    expect(auth.forceRefreshChatGPT).toHaveBeenCalledWith(
      undefined,
      "old-token",
    );
    expect(calls).toBe(3);
    expect(delays).toEqual([10]);
  });

  it("rejects a stream that closes before response.completed", async () => {
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      fetch: (async () =>
        sseResponse([
          { type: "response.output_text.delta", delta: "partial" },
        ])) as typeof fetch,
    });
    await expect(collect(provider.stream(request(), {}))).rejects.toThrow(
      "before response.completed",
    );
  });

  it("rejects inconsistent final tool arguments", async () => {
    const provider = new OpenAICodexProvider({
      auth: fakeAuth(),
      fetch: (async () =>
        sseResponse([
          {
            type: "response.output_item.added",
            item: { type: "function_call", call_id: "c", name: "read" },
          },
          {
            type: "response.function_call_arguments.delta",
            call_id: "c",
            delta: '{"path":"a"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "c",
              name: "read",
              arguments: '{"path":"b"}',
            },
          },
        ])) as typeof fetch,
    });
    await expect(collect(provider.stream(request(), {}))).rejects.toThrow(
      "inconsistent arguments",
    );
  });
});
