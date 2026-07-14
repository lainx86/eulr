import { describe, expect, it } from "vitest";

import {
  AgentTuiEventBridge,
  TuiPermissionBroker,
} from "../../src/tui/event-bridge.js";
import { TuiStore } from "../../src/tui/state/tui-store.js";
import type { SessionState } from "../../src/sessions/state.js";

describe("TuiStore and AgentTuiEventBridge", () => {
  it("starts in an idle state reconstructed from an empty session", () => {
    const store = createStore();

    expect(store.getSnapshot()).toMatchObject({
      phase: "idle",
      companion: "idle",
      focus: "input",
      activities: [],
      statusMessage: "eulr is idle and ready · No active task",
      inspector: {
        activeTab: "answer",
        manuallySelected: false,
        answer: "",
      },
    });
  });

  it("tracks a completed run, streamed answer, and accumulated usage", () => {
    const store = createStore();
    const bridge = new AgentTuiEventBridge(store);
    store.startRun("Fix the failing test");

    bridge.handle({ type: "task_started", sessionId: "session-1" });
    bridge.handle({ type: "thinking" });
    bridge.handle({ type: "text_delta", text: "Fixed " });
    bridge.handle({ type: "text_delta", text: "the test." });
    bridge.handle({ type: "usage", usage: usage(10, 2, 3) });
    bridge.handle({ type: "usage", usage: usage(5, 4, 1) });

    expect(store.getSnapshot()).toMatchObject({
      phase: "working",
      companion: "thinking",
      task: "Fix the failing test",
      usage: usage(15, 6, 4),
      inspector: { answer: "Fixed the test." },
    });

    bridge.handle({
      type: "task_completed",
      sessionId: "session-1",
      turns: 2,
      usage: usage(20, 8, 4),
    });

    const completed = store.getSnapshot();
    expect(completed.phase).toBe("completed");
    expect(completed.companion).toBe("completed");
    expect(completed.focus).toBe("input");
    expect(completed.usage).toEqual(usage(20, 8, 4));
    expect(completed.activities.every((item) => item.status !== "active")).toBe(
      true,
    );
  });

  it.each([
    ["task_failed", "failed", "error"],
    ["task_cancelled", "cancelled", "cancelled"],
  ] as const)(
    "maps %s to its final phase and companion",
    (eventType, phase, companion) => {
      const store = createStore();
      const bridge = new AgentTuiEventBridge(store);
      store.startRun("Run task");

      bridge.handle({
        type: eventType,
        sessionId: "session-1",
        turns: 1,
        usage: usage(1, 1, 0),
        error:
          eventType === "task_failed" ? "Provider unavailable" : "Cancelled",
      });

      expect(store.getSnapshot()).toMatchObject({ phase, companion });
      expect(
        store
          .getSnapshot()
          .activities.every((item) => item.status !== "active"),
      ).toBe(true);
    },
  );

  it("turns read metadata into a file inspector view", () => {
    const store = createStore();
    const bridge = new AgentTuiEventBridge(store);
    store.startRun("Inspect the parser");

    bridge.handle(toolStarted("read-1", "read", "src/parser.ts"));
    expect(store.getSnapshot()).toMatchObject({ companion: "reading" });
    expect(store.getSnapshot().activities.at(-1)).toMatchObject({
      id: "read-1",
      label: "Reading src/parser.ts",
      status: "active",
    });

    bridge.handle({
      type: "tool_finished",
      callId: "read-1",
      toolName: "read",
      isError: false,
      summary: "Read 2 lines",
      content: "src/parser.ts\n1 | export const value = 1;",
      metadata: {
        path: "src/parser.ts",
        preview: "1 | export const value = 1;\n2 | export default value;",
        previewTruncated: true,
      },
    });

    expect(store.getSnapshot().activities.at(-1)).toMatchObject({
      status: "completed",
      detail: "Read 2 lines",
    });
    expect(store.getSnapshot().inspector).toMatchObject({
      activeTab: "file",
      file: {
        path: "src/parser.ts",
        content: "1 | export const value = 1;\n2 | export default value;",
        truncated: true,
      },
    });
  });

  it("turns edit metadata into a diff, including a newly created file", () => {
    const store = createStore();
    const bridge = new AgentTuiEventBridge(store);
    store.startRun("Create config");

    bridge.handle(toolStarted("edit-1", "write", "src/config.ts"));
    expect(store.getSnapshot().companion).toBe("editing");
    bridge.handle({
      type: "tool_finished",
      callId: "edit-1",
      toolName: "write",
      isError: false,
      summary: "Created src/config.ts",
      content: "Created src/config.ts",
      metadata: {
        fileChange: {
          path: "src/config.ts",
          before: null,
          after: "export const enabled = true;\n",
          truncated: false,
        },
      },
    });

    expect(store.getSnapshot().inspector).toMatchObject({
      activeTab: "changes",
      change: {
        path: "src/config.ts",
        before: null,
        after: "export const enabled = true;\n",
      },
    });
  });

  it("streams bash output and preserves the final command metadata", () => {
    const store = createStore();
    const bridge = new AgentTuiEventBridge(store);
    store.startRun("Run tests");

    bridge.handle(toolStarted("bash-1", "bash", "pnpm test"));
    bridge.handle({
      type: "tool_output",
      callId: "bash-1",
      toolName: "bash",
      stream: "stdout",
      chunk: "running tests\n",
    });
    bridge.handle({
      type: "tool_output",
      callId: "bash-1",
      toolName: "bash",
      stream: "stderr",
      chunk: "assertion failed\n",
    });

    expect(store.getSnapshot()).toMatchObject({
      companion: "running",
      inspector: {
        activeTab: "output",
        output: {
          command: "pnpm test",
          stdout: "running tests\n",
          stderr: "assertion failed\n",
          running: true,
        },
      },
    });

    bridge.handle({
      type: "tool_finished",
      callId: "bash-1",
      toolName: "bash",
      isError: true,
      summary: "Command exited with code 1",
      content: "Command: pnpm test\nExit code: 1",
      metadata: {
        command: "pnpm test",
        stdout: "running tests\n",
        stderr: "assertion failed\n",
        exitCode: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });

    expect(store.getSnapshot()).toMatchObject({
      companion: "error",
      inspector: {
        output: {
          command: "pnpm test",
          exitCode: 1,
          running: false,
        },
      },
    });
    expect(store.getSnapshot().activities.at(-1)?.status).toBe("failed");
  });

  it("respects a manually selected inspector tab until an explicit force", () => {
    const store = createStore();
    const bridge = new AgentTuiEventBridge(store);
    store.startRun("Inspect and edit");

    bridge.handle(toolStarted("read-1", "read", "src/a.ts"));
    bridge.handle({
      type: "tool_finished",
      callId: "read-1",
      toolName: "read",
      isError: false,
      summary: "Read file",
      content: "ok",
      metadata: { path: "src/a.ts", preview: "old" },
    });
    expect(store.getSnapshot().inspector.activeTab).toBe("file");

    store.selectInspector("answer");
    bridge.handle(toolStarted("edit-1", "edit", "src/a.ts"));
    bridge.handle({
      type: "tool_finished",
      callId: "edit-1",
      toolName: "edit",
      isError: false,
      summary: "Edited file",
      content: "ok",
      metadata: {
        fileChange: {
          path: "src/a.ts",
          before: "old",
          after: "new",
          truncated: false,
        },
      },
    });

    expect(store.getSnapshot().inspector).toMatchObject({
      activeTab: "answer",
      manuallySelected: true,
      change: { path: "src/a.ts", before: "old", after: "new" },
    });

    store.setChange({ path: "src/a.ts", before: "new", after: "newer" }, true);
    expect(store.getSnapshot().inspector.activeTab).toBe("changes");
  });

  it("integrates permission requests, redaction, and companion restoration", async () => {
    const store = createStore();
    const broker = new TuiPermissionBroker(store);
    store.startRun("Run a command");
    const decision = broker.request({
      category: "execute",
      target: "Authorization: Bearer super-secret-token",
      description: "Execute the requested check",
    });

    expect(store.getSnapshot()).toMatchObject({
      companion: "waiting_permission",
      statusMessage: "Waiting for approval",
      focus: "input",
      permission: { request: { category: "execute" } },
    });
    expect(store.getSnapshot().permission?.request.target).not.toContain(
      "super-secret-token",
    );
    expect(broker.resolve("allow_session")).toBe(true);
    await expect(decision).resolves.toEqual({ allowed: true, remember: true });

    expect(store.getSnapshot()).toMatchObject({
      phase: "working",
      companion: "thinking",
      statusMessage: "Working on the active task",
      permission: undefined,
    });
    expect(broker.active).toBe(false);
  });

  it("follows new activity at the tail while preserving manual scroll", () => {
    const store = createStore();
    store.startRun("Inspect files");
    for (let index = 0; index < 20; index += 1) {
      store.appendActivity({
        id: `read-${index}`,
        label: `Reading file-${index}.ts`,
        status: "completed",
        timestamp: index,
      });
    }
    expect(store.getSnapshot().scroll.activity).toBe(Number.MAX_SAFE_INTEGER);

    store.setFocus("activity");
    store.scrollHome();
    store.appendActivity({
      id: "read-manual",
      label: "Reading manual.ts",
      status: "completed",
      timestamp: 21,
    });
    expect(store.getSnapshot().scroll.activity).toBe(0);

    store.scrollEnd();
    expect(store.getSnapshot().scroll.activity).toBe(Number.MAX_SAFE_INTEGER);
  });
});

function createStore(session = sessionState()): TuiStore {
  return new TuiStore({
    providerId: session.provider,
    model: session.model,
    cwd: session.cwd,
    session,
    version: "0.1.0",
  });
}

function sessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    createdAt: 1,
    updatedAt: 1,
    cwd: "/workspace",
    provider: "fake-provider",
    model: "fake-model",
    status: "active",
    messages: [],
    toolExecutions: [],
    usage: usage(0, 0, 0),
    compactedMessageCount: 0,
    ...overrides,
  };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): SessionState["usage"] {
  return { inputTokens, outputTokens, cachedInputTokens };
}

function toolStarted(callId: string, toolName: string, target: string) {
  return {
    type: "tool_started" as const,
    callId,
    toolName,
    target,
    input: toolName === "bash" ? { command: target } : { path: target },
  };
}
