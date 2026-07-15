import { describe, expect, it, vi } from "vitest";

import { CancellationCoordinator } from "../../src/cli/interactive.js";
import type { InteractiveRuntime } from "../../src/cli/interactive.js";
import type {
  MusicCommand,
  MusicPlaybackState,
} from "../../src/music/types.js";
import type { SessionState } from "../../src/sessions/state.js";
import { TuiPermissionBroker } from "../../src/tui/event-bridge.js";
import { TuiStore } from "../../src/tui/state/tui-store.js";
import {
  TuiController,
  type TuiControllerActions,
  type TuiMusicController,
} from "../../src/tui/tui-controller.js";

describe("TuiController", () => {
  it("submits a task through the real cancellation boundary and flushes its session", async () => {
    const fixture = createFixture();
    const run = deferred<void>();
    fixture.runtime.setRunHandler(async () => {
      await run.promise;
      fixture.store.finishRun("completed", "Task completed");
    });

    fixture.controller.submit("  inspect the repository  ");

    expect(fixture.store.getSnapshot()).toMatchObject({
      phase: "working",
      task: "inspect the repository",
    });
    run.resolve();
    await vi.waitFor(() => {
      expect(fixture.runtime.run).toHaveBeenCalledTimes(1);
      expect(fixture.runtime.flush).toHaveBeenCalledTimes(1);
    });
    expect(fixture.runtime.run.mock.calls[0]?.[0]).toBe(
      "inspect the repository",
    );
    expect(fixture.runtime.run.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fixture.store.getSnapshot().phase).toBe("completed");

    await fixture.controller.shutdown();
  });

  it("queues exactly one follow-up and starts it only after the active run boundary", async () => {
    const fixture = createFixture();
    const runs: Deferred<void>[] = [];
    fixture.runtime.setRunHandler(async () => {
      const run = deferred<void>();
      runs.push(run);
      await run.promise;
      fixture.store.finishRun("completed", "Task completed");
    });

    fixture.controller.submit("first task");
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    fixture.controller.submit("follow-up task");
    fixture.controller.submit("third task");

    expect(fixture.store.getSnapshot().queuedFollowUp).toBe("follow-up task");
    expect(fixture.store.getSnapshot().statusMessage).toContain(
      "One follow-up is already queued",
    );
    expect(fixture.runtime.run).toHaveBeenCalledTimes(1);

    runs[0]?.resolve();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
      expect(fixture.runtime.run).toHaveBeenCalledTimes(2);
    });
    expect(fixture.runtime.run.mock.calls.map(([task]) => task)).toEqual([
      "first task",
      "follow-up task",
    ]);
    expect(fixture.store.getSnapshot().queuedFollowUp).toBeUndefined();

    runs[1]?.resolve();
    await vi.waitFor(() => {
      expect(fixture.runtime.flush).toHaveBeenCalledTimes(2);
      expect(fixture.store.getSnapshot().phase).toBe("completed");
    });
    await fixture.controller.shutdown();
  });

  it("routes slash music commands and focused-player commands to the music service", async () => {
    const fixture = createFixture();

    fixture.controller.submit("/music volume 42");
    await vi.waitFor(() => {
      expect(fixture.music.commands).toEqual([{ type: "volume", volume: 42 }]);
    });
    expect(fixture.store.getSnapshot().music.volume).toBe(42);

    await fixture.controller.musicKey({ type: "toggle" });
    expect(fixture.music.commands.at(-1)).toEqual({ type: "toggle" });
    expect(fixture.store.getSnapshot().music.playing).toBe(true);

    fixture.controller.submit("/music builtin");
    await vi.waitFor(() => {
      expect(fixture.music.commands).toContainEqual({ type: "builtin" });
    });

    fixture.controller.submit("/music status");
    await vi.waitFor(() => {
      expect(fixture.store.getSnapshot().statusMessage).toBe("Playing");
    });

    await fixture.controller.shutdown();
  });

  it("isolates and redacts a music failure so agent tasks remain usable", async () => {
    const fixture = createFixture();
    fixture.music.failure = new Error(
      "mpv failed with Authorization: Bearer music-secret-token",
    );

    fixture.controller.submit("/music play");
    await vi.waitFor(() => {
      expect(fixture.store.getSnapshot().statusMessage).toContain(
        "Music: mpv failed",
      );
    });
    expect(fixture.store.getSnapshot().statusMessage).not.toContain(
      "music-secret-token",
    );
    expect(fixture.store.getSnapshot().phase).toBe("idle");

    fixture.music.failure = undefined;
    fixture.runtime.setRunHandler(async () => {
      fixture.store.finishRun("completed", "Task completed");
    });
    fixture.controller.submit("continue coding");
    await vi.waitFor(() => {
      expect(fixture.runtime.run).toHaveBeenCalledWith(
        "continue coding",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(fixture.store.getSnapshot().phase).toBe("completed");
    });

    await fixture.controller.shutdown();
  });

  it("resolves permission input through the TUI broker and treats interrupt as deny", async () => {
    const fixture = createFixture();
    const remembered = fixture.permissions.request({
      category: "write",
      target: "src/config.ts",
    });

    fixture.controller.resolvePermission("allow_session");
    await expect(remembered).resolves.toEqual({
      allowed: true,
      remember: true,
    });
    expect(fixture.store.getSnapshot().permission).toBeUndefined();

    const denied = fixture.permissions.request({
      category: "execute",
      target: "pnpm test",
    });
    fixture.controller.interrupt();
    await expect(denied).resolves.toEqual({
      allowed: false,
      remember: false,
    });
    expect(fixture.exit).not.toHaveBeenCalled();

    await fixture.controller.shutdown();
  });

  it("selects a model and a session through retained overlays", async () => {
    const fixture = createFixture({ model: "model-a" });
    fixture.runtime.models.splice(
      0,
      fixture.runtime.models.length,
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    );

    fixture.controller.submit("/model");
    await vi.waitFor(() => {
      expect(fixture.store.getSnapshot().overlay).toMatchObject({
        type: "models",
        selectedIndex: 0,
      });
    });
    fixture.store.moveOverlaySelection(1);
    await fixture.controller.confirmOverlaySelection();

    expect(fixture.runtime.setLoopModel).toHaveBeenCalledWith("model-b");
    expect(fixture.runtime.setSessionModel).toHaveBeenCalledWith(
      "session-1",
      "model-b",
    );
    expect(fixture.actions.saveModel).toHaveBeenCalledWith(
      "fake-provider",
      "model-b",
    );
    expect(fixture.store.getSnapshot()).toMatchObject({
      model: "model-b",
      statusMessage: "Model: model-b",
    });

    const resumed = createRuntimeHarness({
      session: sessionState("session-2", "resumed-model"),
      model: "resumed-model",
    });
    fixture.actions.resume.mockResolvedValue(resumed.runtime);
    fixture.runtime.listedSessions.splice(
      0,
      fixture.runtime.listedSessions.length,
      fixture.runtime.getSession(),
      resumed.getSession(),
    );

    fixture.controller.submit("/sessions");
    await vi.waitFor(() => {
      expect(fixture.store.getSnapshot().overlay).toMatchObject({
        type: "sessions",
        selectedIndex: 0,
      });
    });
    fixture.store.moveOverlaySelection(1);
    await fixture.controller.confirmOverlaySelection();

    expect(fixture.actions.resume).toHaveBeenCalledWith("session-2");
    expect(fixture.store.getSnapshot()).toMatchObject({
      sessionId: "session-2",
      model: "resumed-model",
      statusMessage: "Resumed session session-2",
    });

    await fixture.controller.shutdown();
  });

  it("loads the provider catalog and preserves it across a sanitized refresh failure", async () => {
    const fixture = createFixture({ model: "model-a" });
    fixture.runtime.models.splice(
      0,
      fixture.runtime.models.length,
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    );

    await fixture.controller.loadModelCatalog();
    expect(fixture.store.getSnapshot().modelCatalog).toMatchObject({
      providerId: "fake-provider",
      status: "ready",
      models: [{ id: "model-a" }, { id: "model-b" }],
    });

    fixture.runtime.listModels.mockRejectedValueOnce(
      new Error("Authorization: Bearer model-catalog-secret"),
    );
    await fixture.controller.loadModelCatalog();

    const catalog = fixture.store.getSnapshot().modelCatalog;
    expect(catalog.status).toBe("failed");
    expect(catalog.models.map((model) => model.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(catalog.error).toContain("[REDACTED]");
    expect(catalog.error).not.toContain("model-catalog-secret");

    await fixture.controller.shutdown();
  });

  it("cancels an active run and returns the retained state to a cancelled phase", async () => {
    const fixture = createFixture();
    let activeSignal: AbortSignal | undefined;
    fixture.runtime.setRunHandler(
      async (_task, signal) =>
        new Promise<void>((_resolve, reject) => {
          activeSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    fixture.controller.submit("long-running task");
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    fixture.controller.interrupt();

    await vi.waitFor(() => {
      expect(activeSignal?.aborted).toBe(true);
      expect(fixture.store.getSnapshot()).toMatchObject({
        phase: "cancelled",
        companion: "cancelled",
      });
      expect(fixture.runtime.flush).toHaveBeenCalledTimes(1);
    });

    await fixture.controller.shutdown();
  });

  it("exits on idle Ctrl+C and flushes while releasing the music subscription", async () => {
    const fixture = createFixture();
    expect(fixture.music.listenerCount).toBe(1);

    fixture.controller.interrupt();
    expect(fixture.exit).toHaveBeenCalledOnce();

    await fixture.controller.shutdown();
    expect(fixture.runtime.flush).toHaveBeenCalledOnce();
    expect(fixture.music.listenerCount).toBe(0);
  });

  it("shutdown aborts an active run before its final session flush", async () => {
    const fixture = createFixture();
    let aborted = false;
    fixture.runtime.setRunHandler(
      async (_task, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    fixture.controller.submit("still running");
    await vi.waitFor(() => expect(fixture.runtime.run).toHaveBeenCalledOnce());

    await fixture.controller.shutdown();

    expect(aborted).toBe(true);
    expect(fixture.store.getSnapshot().phase).toBe("cancelled");
    expect(fixture.runtime.flush.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.music.listenerCount).toBe(0);
  });
});

interface FixtureOptions {
  model?: string;
}

function createFixture(options: FixtureOptions = {}) {
  const runtime = createRuntimeHarness({ model: options.model });
  const store = new TuiStore({
    providerId: runtime.runtime.providerId,
    model: runtime.runtime.model,
    cwd: runtime.runtime.cwd,
    session: runtime.getSession(),
    version: "0.1.0",
  });
  const permissions = new TuiPermissionBroker(store);
  const cancellation = new CancellationCoordinator();
  const music = new FakeMusicController();
  const actions = {
    login: vi.fn(async () => runtime.runtime),
    logout: vi.fn(async () => true),
    newSession: vi.fn(async () => runtime.runtime),
    resume: vi.fn(async () => runtime.runtime),
    saveModel: vi.fn(async () => undefined),
  } satisfies TuiControllerActions;
  const controller = new TuiController({
    runtime: runtime.runtime,
    store,
    permissions,
    cancellation,
    actions,
    music,
  });
  const exit = vi.fn<(error?: Error) => void>();
  controller.bindApp({
    exit,
    suspendTerminal: async (callback) => callback(),
  });
  return {
    actions,
    cancellation,
    controller,
    exit,
    music,
    permissions,
    runtime,
    store,
  };
}

type RunHandler = (task: string, signal: AbortSignal) => Promise<void>;

interface RuntimeHarnessOptions {
  model?: string;
  session?: SessionState;
}

function createRuntimeHarness(options: RuntimeHarnessOptions = {}) {
  const model = options.model ?? options.session?.model ?? "fake-model";
  let session = options.session ?? sessionState("session-1", model);
  let runHandler: RunHandler = async () => undefined;
  let activeModel = model;
  const models = [{ id: model, name: "Fake model" }];
  const listedSessions = [session];

  const run = vi.fn(
    async (task: string, runOptions: { signal?: AbortSignal } = {}) => {
      const signal = runOptions.signal ?? new AbortController().signal;
      await runHandler(task, signal);
      return { session, turns: 1, response: "done" };
    },
  );
  const flush = vi.fn(async () => undefined);
  const setSessionModel = vi.fn(async (_id: string, nextModel: string) => {
    session = { ...session, model: nextModel };
  });
  const setLoopModel = vi.fn((nextModel: string) => {
    activeModel = nextModel;
  });
  const agent = {
    get session() {
      return session;
    },
    run,
    compact: vi.fn(async () => session),
    refresh: vi.fn(async () => {
      session = { ...session, model: activeModel };
      return session;
    }),
  };
  const sessions = {
    flush,
    list: vi.fn(async () => listedSessions),
    setModel: setSessionModel,
  };
  const provider = {
    id: "fake-provider",
    listModels: vi.fn(async () => models),
    async *stream() {
      yield { type: "done" as const, finishReason: "stop" };
    },
  };
  const runtime = {
    providerId: "fake-provider",
    provider,
    model,
    cwd: "/workspace",
    session,
    sessions,
    loop: { setModel: setLoopModel },
    agent,
  } as unknown as InteractiveRuntime;

  return {
    flush,
    getSession: () => session,
    listedSessions,
    listModels: provider.listModels,
    models,
    run,
    runtime,
    setLoopModel,
    setRunHandler(handler: RunHandler) {
      runHandler = handler;
    },
    setSessionModel,
  };
}

class FakeMusicController implements TuiMusicController {
  readonly commands: MusicCommand[] = [];
  failure?: Error;
  private state = musicState();
  private readonly listeners = new Set<(state: MusicPlaybackState) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  getState(): MusicPlaybackState {
    return this.state;
  }

  subscribe(listener: (state: MusicPlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(command: MusicCommand): Promise<MusicPlaybackState> {
    this.commands.push(command);
    if (this.failure !== undefined) throw this.failure;
    if (command.type === "volume") {
      this.state = { ...this.state, volume: command.volume };
    } else if (command.type === "play" || command.type === "toggle") {
      this.state = {
        ...this.state,
        playing: true,
        statusMessage: "Playing",
      };
    } else if (command.type === "pause") {
      this.state = {
        ...this.state,
        playing: false,
        statusMessage: "Paused",
      };
    }
    for (const listener of this.listeners) listener(this.state);
    return this.state;
  }
}

function musicState(): MusicPlaybackState {
  return {
    available: true,
    statusMessage: "Ready",
    playing: false,
    elapsedSeconds: 0,
    durationSeconds: 180,
    volume: 70,
    shuffle: false,
    repeat: false,
    trackIndex: 0,
    trackCount: 1,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value?: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}

function sessionState(
  id: string,
  model: string,
  status: SessionState["status"] = "active",
): SessionState {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    cwd: "/workspace",
    provider: "fake-provider",
    model,
    status,
    messages: [],
    toolExecutions: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    compactedMessageCount: 0,
  };
}
