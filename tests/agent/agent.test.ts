import { describe, expect, it, vi } from "vitest";

import { Agent } from "../../src/agent/agent.js";
import type { AgentLoop } from "../../src/agent/loop.js";
import type { SessionService } from "../../src/sessions/session-service.js";
import type { SessionState } from "../../src/sessions/state.js";
import { CancellationError, ProviderError } from "../../src/utils/errors.js";

describe("Agent", () => {
  it("refreshes failed session state without replacing the task error", async () => {
    const taskError = new ProviderError("provider failed");
    const failedSession = sessionState("failed");
    const { agent, load } = createAgent(taskError, failedSession);

    await expect(agent.run("Fix it")).rejects.toBe(taskError);

    expect(load).toHaveBeenCalledWith("session-1");
    expect(agent.session).toBe(failedSession);
  });

  it("refreshes cancelled session state", async () => {
    const taskError = new CancellationError("cancelled");
    const cancelledSession = sessionState("cancelled");
    const { agent } = createAgent(taskError, cancelledSession);

    await expect(agent.run("Fix it")).rejects.toBe(taskError);

    expect(agent.session.status).toBe("cancelled");
  });

  it("preserves the task error when refreshing the session also fails", async () => {
    const taskError = new ProviderError("provider failed");
    const loop = {
      runTask: vi.fn().mockRejectedValue(taskError),
    } as unknown as AgentLoop;
    const sessions = {
      load: vi.fn().mockRejectedValue(new Error("session unavailable")),
    } as unknown as SessionService;
    const agent = new Agent(loop, sessions, sessionState("active"));

    await expect(agent.run("Fix it")).rejects.toBe(taskError);

    expect(agent.session.status).toBe("active");
  });
});

function createAgent(
  error: Error,
  refreshedSession: SessionState,
): {
  agent: Agent;
  load: ReturnType<typeof vi.fn>;
} {
  const loop = {
    runTask: vi.fn().mockRejectedValue(error),
  } as unknown as AgentLoop;
  const load = vi.fn().mockResolvedValue(refreshedSession);
  const sessions = { load } as unknown as SessionService;
  return {
    agent: new Agent(loop, sessions, sessionState("active")),
    load,
  };
}

function sessionState(status: SessionState["status"]): SessionState {
  return {
    id: "session-1",
    createdAt: 1,
    updatedAt: 1,
    cwd: "/workspace",
    provider: "fake",
    model: "fake-model",
    status,
    messages: [],
    toolExecutions: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    compactedMessageCount: 0,
  };
}
