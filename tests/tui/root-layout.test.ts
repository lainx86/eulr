import { createElement } from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { computeLayout } from "../../src/tui/layout/constraints.js";
import { RootLayout } from "../../src/tui/layout/root-layout.js";
import type { InputBufferSnapshot } from "../../src/tui/state/input-buffer.js";
import { TuiStore } from "../../src/tui/state/tui-store.js";
import type { SessionState } from "../../src/sessions/state.js";

const EMPTY_INPUT: InputBufferSnapshot = {
  value: "",
  cursor: 0,
  selection: null,
};

describe("RootLayout rendering", () => {
  it.each([
    [140, 42, "full"],
    [100, 30, "compact"],
    [80, 24, "minimum"],
  ] as const)(
    "renders the persistent regions in %s-column %s-row %s mode",
    (width, height, mode) => {
      const store = createStore();
      const layout = computeLayout(width, height);
      const output = renderRoot(store, width, height);
      const lines = output.split("\n");

      expect(layout.mode).toBe(mode);
      expect(lines).toHaveLength(height);

      const mainLine = findLine(lines, "Welcome back.");
      const inputLine = findLine(lines, "eulr ›");
      const dockLine = findLine(lines, "EULR COMPANION");
      const dock = lines[dockLine] ?? "";

      expect(mainLine).toBeLessThan(inputLine);
      expect(inputLine).toBeLessThan(dockLine);
      expect(dock.indexOf("EULR COMPANION")).toBeLessThan(
        dock.indexOf("MUSIC PLAYER"),
      );
    },
  );

  it("keeps input and dock at identical rows between idle and working", () => {
    const store = createStore();
    const idle = renderRoot(store, 140, 42).split("\n");
    store.startRun("Investigate the repository");
    const working = renderRoot(store, 140, 42).split("\n");

    expect(findLine(working, "ACTIVITY / PROGRESS")).toBeLessThan(
      findLine(working, "eulr ›"),
    );
    expect(findLine(working, "CONTEXT INSPECTOR")).toBeLessThan(
      findLine(working, "eulr ›"),
    );
    expect(findLine(working, "eulr ›")).toBe(findLine(idle, "eulr ›"));
    expect(findLine(working, "EULR COMPANION")).toBe(
      findLine(idle, "EULR COMPANION"),
    );
  });

  it("renders a dense idle card with the provider model catalog", () => {
    const store = createStore();
    store.setModelCatalog("fake-provider", [
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      { id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
      { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    ]);
    store.setRuntime({
      providerId: "fake-provider",
      model: "gpt-5.6-sol",
      cwd: "/workspace",
      session: { ...sessionState(), model: "gpt-5.6-sol" },
    });

    const output = renderRoot(store, 160, 44);
    expect(output).toContain("e u l r  ✦");
    expect(output).toContain("Get started");
    expect(output).toContain("Available models");
    expect(output).toContain("gpt-5.6-sol");
    expect(output).toContain("gpt-5.6-terra");
    expect(output).toContain("3 models available");
    expect(output).toContain("Authenticate a provider");
  });

  it("places input help below the field and above the persistent dock", () => {
    const store = createStore();
    const lines = renderRoot(store, 140, 42).split("\n");
    const inputLine = findLine(lines, "eulr ›");
    const helperLine = findLine(lines, "esc interrupt");
    const dockLine = findLine(lines, "EULR COMPANION");

    expect(inputLine).toBeLessThan(helperLine);
    expect(helperLine).toBeLessThan(dockLine);
    expect(lines[helperLine]).not.toContain("│");

    expect(renderRoot(store, 80, 24)).not.toContain("alt+enter newline");
  });

  it("scrolling activity and inspector does not move input or dock", () => {
    const store = createStore();
    store.startRun("Inspect many files");
    for (let index = 0; index < 40; index += 1) {
      store.appendActivity({
        id: `activity-${index}`,
        label: `Reading src/file-${index}.ts`,
        status: "completed",
        timestamp: index,
      });
    }
    const before = renderRoot(store, 120, 34).split("\n");

    store.setFocus("activity");
    store.scrollFocused(20);
    store.selectInspector("answer");
    store.scrollFocused(20);
    const after = renderRoot(store, 120, 34).split("\n");

    expect(findLine(after, "eulr ›")).toBe(findLine(before, "eulr ›"));
    expect(findLine(after, "EULR COMPANION")).toBe(
      findLine(before, "EULR COMPANION"),
    );
  });

  it("renders a permission prompt inside input while preserving the dock", () => {
    const store = createStore();
    store.startRun("Run tests");
    store.setPermission({
      request: {
        category: "execute",
        target: "pnpm test",
      },
    });
    const lines = renderRoot(store, 140, 42).split("\n");

    const permissionLine = findLine(lines, "eulr wants to run: pnpm test");
    const controlsLine = findLine(lines, "[Y] allow once");
    const dockLine = findLine(lines, "EULR COMPANION");
    expect(permissionLine).toBeLessThan(dockLine);
    expect(controlsLine).toBeLessThan(dockLine);
    expect(lines[dockLine]).toContain("MUSIC PLAYER");
  });

  it("uses one visible main panel in minimum working mode", () => {
    const store = createStore();
    store.startRun("Fix the parser");
    const activityOutput = renderRoot(store, 80, 24);
    expect(activityOutput).toContain("Compact terminal");
    expect(activityOutput).toContain("ACTIVITY / PROGRESS");
    expect(activityOutput).not.toContain("CONTEXT INSPECTOR");

    store.setFocus("inspector");
    const inspectorOutput = renderRoot(store, 80, 24);
    expect(inspectorOutput).toContain("CONTEXT INSPECTOR");
    expect(inspectorOutput).not.toContain("ACTIVITY / PROGRESS");
    expect(inspectorOutput).toContain("EULR COMPANION");
    expect(inspectorOutput).toContain("MUSIC PLAYER");
  });

  it("shows the final answer by default after completion in minimum mode", () => {
    const store = createStore();
    store.startRun("Fix the parser");
    store.appendAnswer("The parser is fixed and tests pass.");
    store.finishRun("completed", "Task completed");

    const output = renderRoot(store, 80, 24);
    expect(output).toContain("CONTEXT INSPECTOR");
    expect(output).toContain("The parser is fixed and tests pass.");
    expect(output).not.toContain("ACTIVITY / PROGRESS");
  });

  it.each([
    [40, 8],
    [20, 3],
    [1, 1],
    [0, 0],
  ])("does not crash in a tiny %sx%s terminal", (width, height) => {
    const store = createStore();
    expect(() => renderRoot(store, width, height)).not.toThrow();
    const output = renderRoot(store, width, height);
    if (height > 0)
      expect(output.split("\n").length).toBeLessThanOrEqual(height);
  });
});

function renderRoot(store: TuiStore, width: number, height: number): string {
  const layout = computeLayout(width, height);
  return renderToString(
    createElement(RootLayout, {
      state: store.getSnapshot(),
      input: EMPTY_INPUT,
      layout,
    }),
    { columns: Math.max(1, width) },
  );
}

function findLine(lines: readonly string[], text: string): number {
  const index = lines.findIndex((line) => line.includes(text));
  expect(
    index,
    `Expected rendered output to include ${JSON.stringify(text)}`,
  ).toBeGreaterThanOrEqual(0);
  return index;
}

function createStore(): TuiStore {
  return new TuiStore({
    providerId: "fake-provider",
    model: "fake-model",
    cwd: "/workspace",
    session: sessionState(),
    version: "0.1.0",
  });
}

function sessionState(): SessionState {
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
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    compactedMessageCount: 0,
  };
}
