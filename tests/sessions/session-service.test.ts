import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionService } from "../../src/sessions/session-service.js";
import { SessionStore } from "../../src/sessions/store.js";

describe("SessionService", () => {
  let root: string;
  let service: SessionService;
  let time: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eulr-session-service-"));
    time = 100;
    service = new SessionService(
      new SessionStore({ directory: join(root, "sessions") }),
      () => (time += 1),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates and resumes a cancelled session", async () => {
    const session = await service.create({
      id: "resume-test",
      cwd: root,
      provider: "fake",
      model: "one",
    });
    await service.setStatus(session.id, "cancelled");

    const resumed = await service.resume(session.id);
    expect(resumed.status).toBe("active");
    expect(resumed.cwd).toBe(root);
  });

  it("persists model and compaction state", async () => {
    const session = await service.create({
      id: "compact-test",
      cwd: root,
      provider: "fake",
      model: "one",
    });
    await service.addMessage(session.id, {
      role: "user",
      content: "old message",
      timestamp: time,
    });
    await service.compact(session.id, "User goal\nFix it", 1);
    await service.setModel(session.id, "two");

    const loaded = await service.load(session.id);
    expect(loaded.contextSummary).toContain("Fix it");
    expect(loaded.compactedMessageCount).toBe(1);
    expect(loaded.model).toBe("two");
  });

  it("does not rerun an old pending tool when resuming", async () => {
    const session = await service.create({
      id: "pending-test",
      cwd: root,
      provider: "fake",
      model: "one",
    });
    await service.addMessage(session.id, {
      role: "assistant",
      timestamp: time,
      content: [
        {
          type: "tool_call",
          callId: "old-call",
          toolName: "bash",
          arguments: { command: "echo should-not-run" },
        },
      ],
    });
    await service.toolStarted(session.id, "old-call", "bash", {
      command: "echo should-not-run",
    });
    await service.setStatus(session.id, "cancelled");

    const resumed = await service.resume(session.id);
    const toolMessages = resumed.messages.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      callId: "old-call",
      isError: true,
    });
    expect(toolMessages[0]?.content).toContain("was not rerun");
    expect(resumed.toolExecutions[0]?.finishedAt).toBeDefined();
  });

  it("restores a finished tool result whose message was not flushed", async () => {
    const session = await service.create({
      id: "finished-test",
      cwd: root,
      provider: "fake",
      model: "one",
    });
    await service.addMessage(session.id, {
      role: "assistant",
      timestamp: time,
      content: [
        {
          type: "tool_call",
          callId: "finished-call",
          toolName: "read",
          arguments: { path: "file.ts" },
        },
      ],
    });
    await service.toolStarted(session.id, "finished-call", "read", {
      path: "file.ts",
    });
    await service.toolFinished(
      session.id,
      "finished-call",
      "read",
      "file contents",
      false,
    );

    const resumed = await service.resume(session.id);
    expect(resumed.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "file contents",
      isError: false,
    });
  });
});
