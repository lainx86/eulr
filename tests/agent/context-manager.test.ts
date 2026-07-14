import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactContext } from "../../src/agent/compaction.js";
import { ContextManager } from "../../src/agent/context-manager.js";
import type { AgentMessage } from "../../src/agent/messages.js";
import { ProjectInstructionLoader } from "../../src/agent/project-instructions.js";
import { createSystemPrompt } from "../../src/agent/system-prompt.js";
import { SessionService } from "../../src/sessions/session-service.js";
import type { SessionState } from "../../src/sessions/state.js";
import { SessionStore } from "../../src/sessions/store.js";
import {
  ScriptedProvider,
  finalResponse,
} from "../helpers/scripted-provider.js";

describe("ContextManager", () => {
  it("keeps tool calls paired with their results across compaction", () => {
    const messages: AgentMessage[] = [
      user("first", 1),
      {
        role: "assistant",
        timestamp: 2,
        content: [
          {
            type: "tool_call",
            callId: "one",
            toolName: "read",
            arguments: { path: "one.ts" },
          },
        ],
      },
      {
        role: "tool",
        timestamp: 3,
        callId: "one",
        toolName: "read",
        content: "contents",
        isError: false,
      },
      user("second", 4),
      {
        role: "assistant",
        timestamp: 5,
        content: [{ type: "text", text: "ok" }],
      },
      user("third", 6),
    ];
    const manager = new ContextManager({ preserveRecentMessages: 2 });

    const selection = manager.selectForCompaction(stateWith(messages));

    expect(selection?.compactedMessageCount).toBe(3);
    expect(selection?.messages.at(-1)).toMatchObject({ role: "tool" });
  });

  it("does not compact a single unfinished conversation turn", () => {
    const manager = new ContextManager({ preserveRecentMessages: 1 });
    const messages: AgentMessage[] = [
      user("only turn", 1),
      {
        role: "assistant",
        timestamp: 2,
        content: [
          {
            type: "tool_call",
            callId: "pending",
            toolName: "read",
            arguments: {},
          },
        ],
      },
    ];

    expect(manager.selectForCompaction(stateWith(messages))).toBeUndefined();
  });

  it("uses local estimation when provider usage is unavailable", () => {
    const manager = new ContextManager({
      contextWindow: 100,
      thresholdRatio: 0.5,
    });
    const state = stateWith([user("x".repeat(500), 1)]);

    expect(manager.shouldCompact(state, "system")).toBe(true);
  });

  it("does not count a summary twice when it is already in the system prompt", () => {
    const manager = new ContextManager();
    const withoutSummary = stateWith([user("current", 1)]);
    const withSummary = {
      ...withoutSummary,
      contextSummary: "older facts",
    };
    const prompt = "system\nolder facts";

    expect(manager.estimateTokens(withSummary, prompt)).toBe(
      manager.estimateTokens(withoutSummary, prompt),
    );
  });
});

describe("compactContext", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eulr-compaction-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores a structured summary and keeps the latest turn", async () => {
    const sessions = new SessionService(
      new SessionStore({ directory: join(root, "sessions") }),
    );
    const created = await sessions.create({
      id: "compact-run",
      cwd: root,
      provider: "fake",
      model: "fake-model",
    });
    await sessions.addMessage(created.id, user("old goal", 1));
    await sessions.addMessage(created.id, {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "old answer" }],
    });
    await sessions.addMessage(created.id, user("current goal", 3));
    const session = await sessions.load(created.id);
    const summary = `User goal\nCurrent goal\nRepository facts\nKnown\nFiles inspected\nNone\nFiles changed\nNone\nCommands and results\nNone\nImportant decisions\nNone\nFailed attempts\nNone\nRemaining work\nContinue`;
    const provider = new ScriptedProvider([
      [
        ...finalResponse(summary).slice(0, 1),
        { type: "usage", inputTokens: 20, outputTokens: 10 },
        { type: "done", finishReason: "stop" },
      ],
    ]);

    const result = await compactContext({
      provider,
      model: "fake-model",
      session,
      sessions,
      context: new ContextManager(),
      force: true,
    });

    expect(result?.compactedMessageCount).toBe(2);
    const loaded = await sessions.load(created.id);
    expect(loaded.contextSummary).toBe(summary);
    expect(loaded.messages.slice(loaded.compactedMessageCount)).toEqual([
      user("current goal", 3),
    ]);
    expect(loaded.usage.inputTokens).toBe(20);
  });
});

describe("ProjectInstructionLoader", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eulr-agents-root-"));
    outside = await mkdtemp(join(tmpdir(), "eulr-agents-outside-"));
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it("loads, caches, and reloads root AGENTS.md", async () => {
    await writeFile(join(root, "AGENTS.md"), "Run tests\n");
    const loader = new ProjectInstructionLoader(root);

    expect(await loader.load()).toMatchObject({
      content: "Run tests\n",
      changed: true,
      reloaded: false,
    });
    expect(await loader.load()).toMatchObject({ changed: false });

    await writeFile(join(root, "AGENTS.md"), "Run all tests\n");
    expect(await loader.load()).toMatchObject({
      content: "Run all tests\n",
      changed: true,
      reloaded: true,
    });
  });

  it("limits project instruction size", async () => {
    await writeFile(join(root, "AGENTS.md"), "0123456789abcdef");
    const result = await new ProjectInstructionLoader(root, 8).load();

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("01234567");
    expect(result.content).toContain("truncated at 8 bytes");
  });

  it("rejects an AGENTS.md symlink that escapes the workspace", async () => {
    await writeFile(join(outside, "instructions.md"), "secret");
    await symlink(join(outside, "instructions.md"), join(root, "AGENTS.md"));

    await expect(new ProjectInstructionLoader(root).load()).rejects.toThrow(
      "outside the working directory",
    );
  });

  it("includes project instructions and summary in the system prompt", () => {
    const prompt = createSystemPrompt({
      cwd: root,
      projectInstructions: "Use pnpm",
      contextSummary: "Tests failed",
    });

    expect(prompt).toContain(`Working directory: ${root}`);
    expect(prompt).toContain("Use pnpm");
    expect(prompt).toContain("Tests failed");
  });
});

function user(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

function stateWith(messages: AgentMessage[]): SessionState {
  return {
    id: "context-test",
    createdAt: 0,
    updatedAt: 0,
    cwd: "/workspace",
    provider: "fake",
    model: "fake-model",
    status: "active",
    messages,
    toolExecutions: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    compactedMessageCount: 0,
  };
}
