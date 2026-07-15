import { describe, expect, it, vi } from "vitest";

import type { Agent } from "../../src/agent/agent.js";
import type { AgentLoop } from "../../src/agent/loop.js";
import type { TokenUsage } from "../../src/agent/messages.js";
import {
  CancellationCoordinator,
  runInteractive,
} from "../../src/cli/interactive.js";
import type {
  InteractiveOptions,
  InteractiveRuntime,
} from "../../src/cli/interactive.js";
import type { PromptService } from "../../src/cli/prompts.js";
import type { TerminalRenderer } from "../../src/cli/renderer.js";
import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
} from "../../src/providers/provider.js";
import type { SessionService } from "../../src/sessions/session-service.js";
import type { SessionState } from "../../src/sessions/state.js";
import { CancellationError } from "../../src/utils/errors.js";

describe("runInteractive", () => {
  it("renders the startup header, reports status, and flushes on exit", async () => {
    const fixture = runtimeFixture({
      session: sessionState({
        messages: [{ role: "user", content: "Fix the parser", timestamp: 2 }],
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cachedInputTokens: 10,
        },
      }),
    });
    const renderer = rendererFixture();
    const cancellation = new CancellationCoordinator();

    await runInteractive(
      interactiveOptions(
        fixture.runtime,
        scriptedPrompts("/status", "/exit"),
        renderer.renderer,
        cancellation,
      ),
    );

    expect(renderer.header).toHaveBeenCalledWith({
      provider: "fake",
      model: "active-model",
      cwd: "/workspace",
      sessionId: "session-1",
    });
    expect(renderedLines(renderer.line)).toEqual(
      expect.arrayContaining([
        "provider: fake",
        "model: active-model",
        "cwd: /workspace",
        "session: session-1 (active)",
        "usage: 120 input, 30 output, 10 cached",
        expect.stringMatching(/^context: 1 messages, \d+ chars$/u),
      ]),
    );
    expect(fixture.flush).toHaveBeenCalledOnce();
    expect(cancellation.exitRequested).toBe(true);
  });

  it("reports when no older context can be compacted", async () => {
    const fixture = runtimeFixture();
    const renderer = rendererFixture();

    await runInteractive(
      interactiveOptions(
        fixture.runtime,
        scriptedPrompts("/compact", "/exit"),
        renderer.renderer,
      ),
    );

    expect(fixture.compact).toHaveBeenCalledOnce();
    expect(renderedLines(renderer.line)).toContain(
      "No older context is eligible for compaction.",
    );
    expect(renderedLines(renderer.line)).not.toContain("Context compacted.");
  });

  it("reports a compaction only after the session state advances", async () => {
    const fixture = runtimeFixture({
      session: sessionState({
        messages: [
          { role: "user", content: "old task", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "old answer" }],
            timestamp: 2,
          },
          { role: "user", content: "current task", timestamp: 3 },
        ],
      }),
    });
    fixture.compact.mockImplementation(async () => {
      fixture.agent.session = {
        ...fixture.agent.session,
        contextSummary: "User goal\nContinue the current task",
        compactedMessageCount: 2,
      };
      return fixture.agent.session;
    });
    const renderer = rendererFixture();

    await runInteractive(
      interactiveOptions(
        fixture.runtime,
        scriptedPrompts("/compact", "/exit"),
        renderer.renderer,
      ),
    );

    expect(renderedLines(renderer.line)).toContain("Context compacted.");
  });

  it("lists models and persists an interactive model switch", async () => {
    const fixture = runtimeFixture({
      models: [
        { id: "active-model", name: "Active" },
        { id: "next-model", name: "Next" },
      ],
    });
    fixture.refresh.mockImplementation(async () => {
      fixture.agent.session = {
        ...fixture.agent.session,
        model: "next-model",
      };
      return fixture.agent.session;
    });
    const renderer = rendererFixture();
    const saveModel = vi.fn(async () => undefined);

    await runInteractive({
      ...interactiveOptions(
        fixture.runtime,
        scriptedPrompts("/model", "/model next-model", "/exit"),
        renderer.renderer,
      ),
      saveModel,
    });

    expect(renderedLines(renderer.line)).toEqual(
      expect.arrayContaining([
        "* active-model - Active",
        "  next-model - Next",
        "Model: next-model",
      ]),
    );
    expect(fixture.setModel).toHaveBeenCalledWith("next-model");
    expect(fixture.sessionSetModel).toHaveBeenCalledWith(
      "session-1",
      "next-model",
    );
    expect(saveModel).toHaveBeenCalledWith("fake", "next-model");
  });

  it("switches to a resumed runtime for subsequent commands", async () => {
    const initial = runtimeFixture();
    const resumed = runtimeFixture({
      providerId: "resumed-provider",
      model: "resumed-model",
      session: sessionState({
        id: "resumed-session",
        provider: "resumed-provider",
        model: "resumed-model",
      }),
    });
    resumed.runtime.sessions = initial.runtime.sessions;
    const renderer = rendererFixture();
    const resume = vi.fn(async () => resumed.runtime);

    await runInteractive({
      ...interactiveOptions(
        initial.runtime,
        scriptedPrompts("/resume resumed-session", "/status", "/exit"),
        renderer.renderer,
      ),
      resume,
    });

    expect(resume).toHaveBeenCalledWith("resumed-session");
    expect(renderer.header).toHaveBeenLastCalledWith({
      provider: "resumed-provider",
      model: "resumed-model",
      cwd: "/workspace",
      sessionId: "resumed-session",
    });
    expect(renderedLines(renderer.line)).toContain(
      "session: resumed-session (active)",
    );
  });

  it("lists sessions when /resume omits the session ID", async () => {
    const fixture = runtimeFixture();
    const sessions = [
      sessionState({ id: "session-2", updatedAt: 20 }),
      sessionState({ id: "session-1", updatedAt: 10 }),
    ];
    vi.mocked(fixture.runtime.sessions.list).mockResolvedValue(sessions);
    const renderer = rendererFixture();
    const resume = vi.fn(async () => fixture.runtime);

    await runInteractive({
      ...interactiveOptions(
        fixture.runtime,
        scriptedPrompts("/resume", "/exit"),
        renderer.renderer,
      ),
      resume,
    });

    expect(resume).not.toHaveBeenCalled();
    expect(renderedLines(renderer.line)).toContain(
      "Use /resume <session-id> to resume.",
    );
    expect(
      renderedLines(renderer.line).some((line) =>
        String(line).includes("session-2"),
      ),
    ).toBe(true);
  });
});

describe("CancellationCoordinator", () => {
  it("uses the first Ctrl+C to abort an active operation", async () => {
    const coordinator = new CancellationCoordinator();
    let operationSignal: AbortSignal | undefined;
    const operation = coordinator.run(
      async (signal) =>
        new Promise<void>((_resolve, reject) => {
          operationSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const assertion =
      expect(operation).rejects.toBeInstanceOf(CancellationError);

    coordinator.onSigint();

    await assertion;
    expect(operationSignal?.aborted).toBe(true);
    expect(coordinator.exitRequested).toBe(false);

    coordinator.onSigint();
    expect(coordinator.exitRequested).toBe(true);
  });

  it("aborts an input prompt and requests exit on Ctrl+C", async () => {
    const coordinator = new CancellationCoordinator();
    const prompts = {
      ask: vi.fn(
        async (_question: string, signal?: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    } as unknown as PromptService;
    const pending = coordinator.ask(prompts, "> ");
    const assertion = expect(pending).rejects.toBeInstanceOf(CancellationError);

    coordinator.onSigint();

    await assertion;
    expect(coordinator.exitRequested).toBe(true);
  });
});

interface RuntimeFixture {
  runtime: InteractiveRuntime;
  agent: { session: SessionState };
  compact: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  sessionSetModel: ReturnType<typeof vi.fn>;
}

function runtimeFixture(
  options: {
    providerId?: string;
    model?: string;
    session?: SessionState;
    models?: ModelInfo[];
  } = {},
): RuntimeFixture {
  const model = options.model ?? "active-model";
  const providerId = options.providerId ?? "fake";
  const initialSession =
    options.session ?? sessionState({ provider: providerId, model });
  const compact = vi.fn(async () => initialSession);
  const refresh = vi.fn(async () => initialSession);
  const agent = {
    session: initialSession,
    run: vi.fn(async () => undefined),
    compact,
    refresh,
  };
  const flush = vi.fn(async () => undefined);
  const sessionSetModel = vi.fn(async () => undefined);
  const sessionSetReasoningEffort = vi.fn(async () => undefined);
  const sessions = {
    flush,
    setModel: sessionSetModel,
    setReasoningEffort: sessionSetReasoningEffort,
    list: vi.fn(async () => []),
  } as unknown as SessionService;
  const setModel = vi.fn();
  const setReasoningEffort = vi.fn();
  const loop = { setModel, setReasoningEffort } as unknown as AgentLoop;
  const provider: ModelProvider = {
    id: providerId,
    listModels: vi.fn(async () => options.models ?? []),
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "done", finishReason: "stop" };
    },
  };

  return {
    runtime: {
      providerId,
      provider,
      model,
      cwd: initialSession.cwd,
      session: initialSession,
      sessions,
      loop,
      agent: agent as unknown as Agent,
    },
    agent,
    compact,
    refresh,
    flush,
    setModel,
    sessionSetModel,
  };
}

function sessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    createdAt: 1,
    updatedAt: 1,
    cwd: "/workspace",
    provider: "fake",
    model: "active-model",
    status: "active",
    messages: [],
    toolExecutions: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    compactedMessageCount: 0,
    ...overrides,
  };
}

function scriptedPrompts(...answers: string[]): PromptService {
  const pending = [...answers];
  return {
    ask: vi.fn(async () => {
      const answer = pending.shift();
      if (answer === undefined) throw new Error("No scripted prompt answer");
      return answer;
    }),
  } as unknown as PromptService;
}

function interactiveOptions(
  runtime: InteractiveRuntime,
  prompts: PromptService,
  renderer: TerminalRenderer,
  cancellation = new CancellationCoordinator(),
): InteractiveOptions {
  return {
    runtime,
    prompts,
    renderer,
    cancellation,
    login: vi.fn(async () => runtime),
    logout: vi.fn(async () => false),
    newSession: vi.fn(async () => runtime),
    resume: vi.fn(async () => runtime),
    saveModel: vi.fn(async () => undefined),
  };
}

function rendererFixture(): {
  renderer: TerminalRenderer;
  header: ReturnType<typeof vi.fn>;
  line: ReturnType<typeof vi.fn>;
} {
  const header = vi.fn();
  const line = vi.fn();
  return {
    renderer: {
      header,
      line,
      clear: vi.fn(),
      error: vi.fn(),
      renderUsage: vi.fn(
        (usage: TokenUsage) =>
          `${usage.inputTokens} input, ${usage.outputTokens} output, ${usage.cachedInputTokens} cached`,
      ),
    } as unknown as TerminalRenderer,
    header,
    line,
  };
}

function renderedLines(line: ReturnType<typeof vi.fn>): unknown[] {
  return line.mock.calls.map((call) => call[0]);
}
