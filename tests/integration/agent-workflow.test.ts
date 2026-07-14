import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentLoop } from "../../src/agent/loop.js";
import { PermissionManager } from "../../src/permissions/permission-manager.js";
import { SessionService } from "../../src/sessions/session-service.js";
import { SessionStore } from "../../src/sessions/store.js";
import { createDefaultToolRegistry } from "../../src/tools/registry.js";
import {
  AgentTuiEventBridge,
  TuiPermissionBroker,
} from "../../src/tui/event-bridge.js";
import { TuiStore } from "../../src/tui/state/tui-store.js";
import {
  ScriptedProvider,
  finalResponse,
  toolCall,
} from "../helpers/scripted-provider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("coding workflow integration", () => {
  it("reads, edits, verifies, and persists a completed session", async () => {
    const root = await mkdtemp(join(tmpdir(), "eulr-integration-"));
    roots.push(root);
    const sessionsDirectory = join(root, ".sessions");
    await writeFile(join(root, "value.js"), "export const value = 1;\n");
    const verifyCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "const fs=require('node:fs'); const text=fs.readFileSync('value.js','utf8'); if(!text.includes('value = 2')) process.exit(1)",
    )}`;
    const provider = new ScriptedProvider(
      [
        [...toolCall("read-1", "read", '{"path":"value.js"}'), done()],
        [
          ...toolCall(
            "edit-1",
            "edit",
            '{"path":"value.js","oldText":"value = 1","newText":"value = 2"}',
          ),
          done(),
        ],
        [
          ...toolCall(
            "bash-1",
            "bash",
            JSON.stringify({ command: verifyCommand, timeoutMs: 10_000 }),
          ),
          done(),
        ],
        finalResponse("The bug is fixed and the fixture check passes."),
      ],
      "fake",
    );
    const sessions = new SessionService(
      new SessionStore({ directory: sessionsDirectory }),
    );
    const session = await sessions.create({
      cwd: root,
      provider: "fake",
      model: "fake-model",
    });
    const loop = new AgentLoop({
      provider,
      model: "fake-model",
      tools: createDefaultToolRegistry(),
      permissions: new PermissionManager({ yes: true }),
      sessions,
    });

    const result = await loop.runTask(
      session,
      "Fix the fixture bug and verify it",
    );

    expect(await readFile(join(root, "value.js"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(result.session.status).toBe("completed");
    expect(result.finalText).toContain("fixture check passes");
    expect(provider.requests).toHaveLength(4);
    const finalContext = provider.requests[3]?.messages ?? [];
    expect(
      finalContext.some(
        (message) =>
          message.role === "tool" &&
          message.toolName === "bash" &&
          !message.isError &&
          message.content.includes("Exit code: 0"),
      ),
    ).toBe(true);
    const stored = await sessions.load(session.id);
    expect(stored.status).toBe("completed");
    expect(stored.toolExecutions).toHaveLength(3);
  });

  it("drives retained TUI state through failure, permission, diff, and completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "eulr-tui-integration-"));
    roots.push(root);
    await writeFile(join(root, "value.js"), "export const value = 1;\n");
    const failCommand = "printf 'fixture failed\\n' >&2; exit 1";
    const verifyCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "const fs=require('node:fs'); const text=fs.readFileSync('value.js','utf8'); if(!text.includes('value = 2')) process.exit(1)",
    )} && printf 'fixture passed\\n'`;
    const provider = new ScriptedProvider(
      [
        [...toolCall("read-1", "read", '{"path":"value.js"}'), done()],
        [
          ...toolCall(
            "bash-fail",
            "bash",
            JSON.stringify({ command: failCommand }),
          ),
          done(),
        ],
        [
          ...toolCall(
            "edit-1",
            "edit",
            '{"path":"value.js","oldText":"value = 1","newText":"value = 2"}',
          ),
          done(),
        ],
        [
          ...toolCall(
            "bash-pass",
            "bash",
            JSON.stringify({ command: verifyCommand }),
          ),
          done(),
        ],
        finalResponse("Fixed the fixture and verified the passing check."),
      ],
      "fake",
    );
    const sessions = new SessionService(
      new SessionStore({ directory: join(root, ".sessions") }),
    );
    const session = await sessions.create({
      cwd: root,
      provider: "fake",
      model: "fake-model",
    });
    const store = new TuiStore({
      providerId: "fake",
      model: "fake-model",
      cwd: root,
      session,
      version: "0.1.0",
    });
    const bridge = new AgentTuiEventBridge(store);
    let failedCommandOutput = "";
    const broker = new TuiPermissionBroker(store);
    const approvals: string[] = [];
    const permissions = new PermissionManager({
      prompt: async (request) => {
        approvals.push(request.category);
        const decision = broker.request(request);
        expect(store.getSnapshot().permission?.request.category).toBe(
          request.category,
        );
        queueMicrotask(() => broker.resolve("allow_session"));
        return decision;
      },
    });
    const loop = new AgentLoop({
      provider,
      model: "fake-model",
      tools: createDefaultToolRegistry(),
      permissions,
      sessions,
      emit: (event) => {
        bridge.handle(event);
        if (event.type === "tool_finished" && event.callId === "bash-fail") {
          failedCommandOutput =
            store.getSnapshot().inspector.output?.stderr ?? "";
        }
      },
    });

    store.startRun("Fix and verify the fixture");
    await loop.runTask(session, "Fix and verify the fixture");

    const state = store.getSnapshot();
    expect(await readFile(join(root, "value.js"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(approvals).toEqual(["execute", "write"]);
    expect(state).toMatchObject({
      phase: "completed",
      companion: "completed",
      permission: undefined,
      inspector: {
        activeTab: "answer",
        answer: "Fixed the fixture and verified the passing check.",
        file: { path: "value.js" },
        change: {
          path: "value.js",
          before: "export const value = 1;\n",
          after: "export const value = 2;\n",
        },
        output: {
          command: verifyCommand,
          exitCode: 0,
          running: false,
        },
      },
    });
    expect(failedCommandOutput).toContain("fixture failed");
    expect(
      state.activities.some(
        (activity) =>
          activity.id === "bash-fail" && activity.status === "failed",
      ),
    ).toBe(true);
    expect(
      state.activities.some(
        (activity) =>
          activity.id === "bash-pass" && activity.status === "completed",
      ),
    ).toBe(true);
  });
});

function done() {
  return { type: "done", finishReason: "tool_calls" } as const;
}
