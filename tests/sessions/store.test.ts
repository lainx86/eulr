import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "../../src/sessions/events.js";
import { SessionStore } from "../../src/sessions/store.js";
import { SessionError } from "../../src/utils/errors.js";

describe("SessionStore", () => {
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eulr-session-store-"));
    store = new SessionStore({ directory: join(root, "sessions") });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends events and reconstructs session state", async () => {
    await store.append("test-session", created(root));
    await store.append("test-session", {
      type: "message_added",
      timestamp: 2,
      message: { role: "user", content: "fix it", timestamp: 2 },
    });
    await store.append("test-session", {
      type: "usage_updated",
      timestamp: 3,
      usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 },
    });
    await store.append("test-session", {
      type: "session_status_changed",
      timestamp: 4,
      status: "completed",
    });

    const state = await store.load("test-session");
    expect(state.messages).toHaveLength(1);
    expect(state.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cachedInputTokens: 2,
    });
    expect(state.status).toBe("completed");
  });

  it("rejects an invalid non-final event", async () => {
    await store.append("test-session", created(root));
    const path = join(store.directory, "test-session.jsonl");
    await appendFile(path, '{"type":"not-an-event"}\n');
    await appendFile(path, `${JSON.stringify(statusEvent("completed"))}\n`);

    await expect(store.loadEvents("test-session")).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it("tolerates a partial final JSONL line", async () => {
    await store.append("test-session", created(root));
    await appendFile(
      join(store.directory, "test-session.jsonl"),
      '{"type":"mess',
    );

    const events = await store.loadEvents("test-session");
    expect(events).toHaveLength(1);
  });

  it("repairs a partial tail before a later append", async () => {
    await store.append("test-session", created(root));
    const path = join(store.directory, "test-session.jsonl");
    await appendFile(path, '{"type":"mess');

    await store.append("test-session", statusEvent("cancelled"));

    const state = await store.load("test-session");
    expect(state.status).toBe("cancelled");
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("accepts a valid final event even when its newline is missing", async () => {
    await store.append("test-session", created(root));
    const path = join(store.directory, "test-session.jsonl");
    const initial = await readFile(path, "utf8");
    await writeFile(path, `${initial}${JSON.stringify(statusEvent("failed"))}`);

    expect((await store.load("test-session")).status).toBe("failed");
    await store.append("test-session", statusEvent("active"));
    expect((await store.load("test-session")).status).toBe("active");
  });

  it("repairs a final event larger than the tail read chunk", async () => {
    await store.append("test-session", created(root));
    const path = join(store.directory, "test-session.jsonl");
    const event: SessionEvent = {
      type: "message_added",
      timestamp: 2,
      message: {
        role: "user",
        content: "x".repeat(40_000),
        timestamp: 2,
      },
    };
    await appendFile(path, JSON.stringify(event));

    await store.append("test-session", statusEvent("completed"));

    const state = await store.load("test-session");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user" });
    expect(state.status).toBe("completed");
  });
});

function created(cwd: string): SessionEvent {
  return {
    type: "session_created",
    timestamp: 1,
    sessionId: "test-session",
    cwd,
    provider: "fake",
    model: "fake-model",
  };
}

function statusEvent(
  status: "active" | "completed" | "failed" | "cancelled",
): SessionEvent {
  return {
    type: "session_status_changed",
    timestamp: Date.now(),
    status,
  };
}
