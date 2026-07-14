import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentLoop } from "../../src/agent/loop.js";
import type { PermissionChecker } from "../../src/permissions/types.js";
import type { ModelEvent } from "../../src/providers/provider.js";
import { SessionService } from "../../src/sessions/session-service.js";
import type { SessionState } from "../../src/sessions/state.js";
import { SessionStore } from "../../src/sessions/store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/tool.js";
import { CancellationError, ProviderError } from "../../src/utils/errors.js";
import {
  ScriptedProvider,
  finalResponse,
  toolCall,
} from "../helpers/scripted-provider.js";
import type { ScriptedTurn } from "../helpers/scripted-provider.js";

describe("AgentLoop", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eulr-agent-loop-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("streams and persists a final response without tools", async () => {
    const harness = await createHarness(root, [finalResponse("Done.")]);

    const result = await harness.loop.runTask(harness.session, "Fix it");

    expect(result.finalText).toBe("Done.");
    expect(result.turns).toBe(1);
    expect(result.session.status).toBe("completed");
    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.events).toContainEqual({
      type: "text_delta",
      text: "Done.",
    });
    expect(harness.events).toContainEqual({
      type: "task_completed",
      sessionId: "agent-test",
      turns: 1,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    });
  });

  it("runs one tool and sends its result back to the model", async () => {
    const execute = vi.fn(async () => ({ content: "tool output" }));
    const harness = await createHarness(
      root,
      [
        [...toolCall("call-1", "record", '{"value":"one"}'), done()],
        finalResponse("Fixed."),
      ],
      { tools: new ToolRegistry([recordTool(execute)]) },
    );

    const result = await harness.loop.runTask(harness.session, "Fix it");

    expect(result.finalText).toBe("Fixed.");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolMessages(harness.provider.requests[1]?.messages)).toContainEqual(
      expect.objectContaining({ content: "tool output", isError: false }),
    );
  });

  it("runs multiple calls from one response sequentially", async () => {
    const order: string[] = [];
    let running = false;
    const execute = vi.fn(async (input: { value: string }) => {
      expect(running).toBe(false);
      running = true;
      await Promise.resolve();
      order.push(input.value);
      running = false;
      return { content: input.value };
    });
    const harness = await createHarness(
      root,
      [
        [
          ...toolCall("call-1", "record", '{"value":"first"}'),
          ...toolCall("call-2", "record", '{"value":"second"}'),
          done(),
        ],
        finalResponse("Done."),
      ],
      { tools: new ToolRegistry([recordTool(execute)]) },
    );

    await harness.loop.runTask(harness.session, "Run both");

    expect(order).toEqual(["first", "second"]);
    expect(toolMessages(harness.provider.requests[1]?.messages)).toHaveLength(
      2,
    );
  });

  it("emits correlated tool input, output, content, and metadata", async () => {
    const streamingTool: Tool<{ value: string }> = {
      name: "streaming-record",
      description: "Record and stream a value",
      inputSchema: z.object({ value: z.string() }),
      permission: "read",
      execute: async (input, context) => {
        context.onOutput?.("stdout", `live:${input.value}`);
        return {
          content: `stored:${input.value}`,
          metadata: { stored: input.value },
        };
      },
    };
    const harness = await createHarness(
      root,
      [
        [
          ...toolCall("correlated-call", "streaming-record", '{"value":"one"}'),
          done(),
        ],
        finalResponse("Done."),
      ],
      { tools: new ToolRegistry([streamingTool]) },
    );

    await harness.loop.runTask(harness.session, "Record it");

    expect(harness.events).toContainEqual({
      type: "tool_started",
      callId: "correlated-call",
      toolName: "streaming-record",
      target: "streaming-record",
      input: { value: "one" },
    });
    expect(harness.events).toContainEqual({
      type: "tool_output",
      callId: "correlated-call",
      toolName: "streaming-record",
      stream: "stdout",
      chunk: "live:one",
    });
    expect(harness.events).toContainEqual({
      type: "tool_finished",
      callId: "correlated-call",
      toolName: "streaming-record",
      isError: false,
      summary: "stored:one",
      content: "stored:one",
      metadata: { stored: "one" },
    });
  });

  it("returns malformed tool arguments to the model as an error", async () => {
    const execute = vi.fn(async () => ({ content: "not called" }));
    const harness = await createHarness(
      root,
      [
        [...toolCall("bad-json", "record", "{"), done()],
        finalResponse("Recovered."),
      ],
      { tools: new ToolRegistry([recordTool(execute)]) },
    );

    await harness.loop.runTask(harness.session, "Try tool");

    expect(execute).not.toHaveBeenCalled();
    expect(
      toolMessages(harness.provider.requests[1]?.messages)[0],
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("Malformed JSON"),
    });
  });

  it("returns an unknown tool error and continues", async () => {
    const harness = await createHarness(root, [
      [...toolCall("unknown", "missing", "{}"), done()],
      finalResponse("Recovered."),
    ]);

    const result = await harness.loop.runTask(
      harness.session,
      "Use missing tool",
    );

    expect(result.session.status).toBe("completed");
    expect(
      toolMessages(harness.provider.requests[1]?.messages)[0],
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("Unknown tool: missing"),
    });
  });

  it("returns tool validation failures to the model", async () => {
    const execute = vi.fn(async () => ({ content: "not called" }));
    const harness = await createHarness(
      root,
      [
        [...toolCall("invalid", "record", "{}"), done()],
        finalResponse("Handled."),
      ],
      { tools: new ToolRegistry([recordTool(execute)]) },
    );

    await harness.loop.runTask(harness.session, "Validate");

    expect(execute).not.toHaveBeenCalled();
    expect(
      toolMessages(harness.provider.requests[1]?.messages)[0],
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("Invalid arguments"),
    });
  });

  it("returns tool execution failures to the model", async () => {
    const harness = await createHarness(
      root,
      [
        [...toolCall("failure", "record", '{"value":"one"}'), done()],
        finalResponse("Explained."),
      ],
      {
        tools: new ToolRegistry([
          recordTool(async () => {
            throw new Error("broken tool");
          }),
        ]),
      },
    );

    await harness.loop.runTask(harness.session, "Run it");

    expect(
      toolMessages(harness.provider.requests[1]?.messages)[0],
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("broken tool"),
    });
  });

  it("returns permission denial to the model", async () => {
    const execute = vi.fn(async () => ({ content: "not called" }));
    const permissions: PermissionChecker = {
      check: vi.fn(async () => false),
    };
    const harness = await createHarness(
      root,
      [
        [...toolCall("denied", "record", '{"value":"one"}'), done()],
        finalResponse("Permission denied."),
      ],
      {
        tools: new ToolRegistry([recordTool(execute)]),
        permissions,
      },
    );

    await harness.loop.runTask(harness.session, "Run it");

    expect(execute).not.toHaveBeenCalled();
    expect(
      toolMessages(harness.provider.requests[1]?.messages)[0],
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("Permission denied"),
    });
  });

  it("marks the session failed on provider error", async () => {
    const harness = await createHarness(root, [new Error("provider offline")]);

    await expect(
      harness.loop.runTask(harness.session, "Try it"),
    ).rejects.toThrow("provider offline");

    expect((await harness.sessions.load(harness.session.id)).status).toBe(
      "failed",
    );
    expect(harness.events).toContainEqual({
      type: "task_failed",
      sessionId: "agent-test",
      turns: 1,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      error: "Model stream failed: provider offline",
    });
  });

  it("redacts secrets from task failure events", async () => {
    const harness = await createHarness(root, [
      new Error(
        "request failed: Authorization: Bearer secret-token access_token=second-secret",
      ),
    ]);

    await expect(
      harness.loop.runTask(harness.session, "Try it"),
    ).rejects.toThrow("request failed");

    const failure = harness.events.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "task_failed",
    );
    expect(failure).toMatchObject({
      type: "task_failed",
      error: expect.stringContaining("[REDACTED]"),
    });
    expect(JSON.stringify(failure)).not.toContain("secret-token");
    expect(JSON.stringify(failure)).not.toContain("second-secret");
  });

  it("cancels an active stream and preserves partial history", async () => {
    const controller = new AbortController();
    const waitingTurn: ScriptedTurn = async function* (_request, options) {
      yield { type: "reasoning_delta", text: "private partial" };
      await new Promise<void>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(new DOMException("The operation was aborted", "AbortError"));
        if (options.signal?.aborted) {
          rejectAbort();
        } else {
          options.signal?.addEventListener("abort", rejectAbort, {
            once: true,
          });
        }
      });
    };
    const harness = await createHarness(root, [waitingTurn]);

    const running = harness.loop.runTask(harness.session, "Wait", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(1));
    controller.abort();

    await expect(running).rejects.toBeInstanceOf(CancellationError);
    const state = await harness.sessions.load(harness.session.id);
    expect(state.status).toBe("cancelled");
    expect(state.messages).toContainEqual(
      expect.objectContaining({ role: "assistant" }),
    );
    expect(harness.events).toContainEqual({
      type: "task_cancelled",
      sessionId: "agent-test",
      turns: 1,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      error: "Model stream was cancelled",
    });
  });

  it("enforces the maximum model turn limit", async () => {
    const execute = vi.fn(async () => ({ content: "again" }));
    const harness = await createHarness(
      root,
      [
        [...toolCall("one", "record", '{"value":"one"}'), done()],
        [...toolCall("two", "record", '{"value":"two"}'), done()],
      ],
      { tools: new ToolRegistry([recordTool(execute)]), maxTurns: 2 },
    );

    await expect(harness.loop.runTask(harness.session, "Loop")).rejects.toThrow(
      "Maximum model turn limit reached (2)",
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect((await harness.sessions.load(harness.session.id)).status).toBe(
      "failed",
    );
  });

  it("turns an incomplete streamed tool call into an error result", async () => {
    const execute = vi.fn(async () => ({ content: "not called" }));
    const harness = await createHarness(
      root,
      [
        [
          ...toolCall("partial", "record", '{"value":"one"}', { end: false }),
          done(),
        ],
        finalResponse("Recovered."),
      ],
      { tools: new ToolRegistry([recordTool(execute)]) },
    );

    await harness.loop.runTask(harness.session, "Partial");

    expect(execute).not.toHaveBeenCalled();
    expect(
      toolMessages(harness.provider.requests[1]?.messages)[0],
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("before its arguments were complete"),
    });
  });

  it("rejects a response stream without a final event", async () => {
    const harness = await createHarness(root, [
      [{ type: "text_delta", text: "partial" }],
    ]);

    await expect(
      harness.loop.runTask(harness.session, "No done"),
    ).rejects.toBeInstanceOf(ProviderError);
    const state = await harness.sessions.load(harness.session.id);
    expect(state.status).toBe("failed");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("accumulates usage across model turns", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const harness = await createHarness(
      root,
      [
        [
          ...toolCall("usage-call", "record", '{"value":"one"}'),
          {
            type: "usage",
            inputTokens: 10,
            outputTokens: 4,
            cachedInputTokens: 2,
          },
          done(),
        ],
        [
          { type: "text_delta", text: "Done." },
          {
            type: "usage",
            inputTokens: 5,
            outputTokens: 3,
            cachedInputTokens: 1,
          },
          done(),
        ],
      ],
      { tools: new ToolRegistry([recordTool(execute)]) },
    );

    const result = await harness.loop.runTask(harness.session, "Usage");

    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 7,
      cachedInputTokens: 3,
    });
    expect(result.session.usage).toEqual(result.usage);
  });
});

async function createHarness(
  root: string,
  turns: Iterable<ScriptedTurn>,
  options: {
    tools?: ToolRegistry;
    permissions?: PermissionChecker;
    maxTurns?: number;
  } = {},
): Promise<{
  loop: AgentLoop;
  provider: ScriptedProvider;
  sessions: SessionService;
  session: SessionState;
  events: unknown[];
}> {
  const provider = new ScriptedProvider(turns);
  const sessions = new SessionService(
    new SessionStore({ directory: join(root, "sessions") }),
  );
  const session = await sessions.create({
    id: "agent-test",
    cwd: root,
    provider: provider.id,
    model: "fake-model",
  });
  const events: unknown[] = [];
  const loop = new AgentLoop({
    provider,
    model: "fake-model",
    tools: options.tools ?? new ToolRegistry(),
    permissions:
      options.permissions ??
      ({ check: async () => true } satisfies PermissionChecker),
    sessions,
    maxTurns: options.maxTurns,
    emit: (event) => events.push(event),
  });
  return { loop, provider, sessions, session, events };
}

function recordTool(
  execute: (input: { value: string }) => Promise<{ content: string }>,
): Tool<{ value: string }> {
  return {
    name: "record",
    description: "Record a value",
    inputSchema: z.object({ value: z.string() }),
    permission: "read",
    execute,
  };
}

function done(): ModelEvent {
  return { type: "done", finishReason: "tool_calls" };
}

function toolMessages(messages: readonly unknown[] | undefined): Array<{
  role: "tool";
  content: string;
  isError: boolean;
}> {
  return (messages ?? []).filter(
    (message): message is { role: "tool"; content: string; isError: boolean } =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "tool",
  );
}
