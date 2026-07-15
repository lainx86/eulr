import type { InteractiveRuntime } from "../cli/interactive.js";
import { CancellationCoordinator } from "../cli/interactive.js";
import { parseInteractiveCommand } from "../cli/commands.js";
import type { MusicCommand, MusicPlaybackState } from "../music/types.js";
import type { PermissionChoice, TuiPermissionBroker } from "./event-bridge.js";
import type { TuiStore } from "./state/tui-store.js";
import { redactText, sanitizeError } from "../auth/redaction.js";
import { ConfigurationError, isAbortError } from "../utils/errors.js";

export interface TuiMusicController {
  getState(): MusicPlaybackState;
  subscribe(listener: (state: MusicPlaybackState) => void): () => void;
  execute(
    command: MusicCommand,
    signal?: AbortSignal,
  ): Promise<MusicPlaybackState>;
}

export interface TuiControllerActions {
  login(
    signal: AbortSignal,
    runtime: InteractiveRuntime,
  ): Promise<InteractiveRuntime>;
  logout(providerId: string): Promise<boolean>;
  newSession(runtime: InteractiveRuntime): Promise<InteractiveRuntime>;
  resume(sessionId: string): Promise<InteractiveRuntime>;
  saveModel(providerId: string, modelId: string): Promise<void>;
}

export interface TuiControllerOptions {
  runtime: InteractiveRuntime;
  store: TuiStore;
  permissions: TuiPermissionBroker;
  cancellation: CancellationCoordinator;
  actions: TuiControllerActions;
  music: TuiMusicController;
}

type SuspendTerminal = (callback: () => void | Promise<void>) => Promise<void>;

export class TuiController {
  private runtime: InteractiveRuntime;
  private readonly store: TuiStore;
  private readonly permissions: TuiPermissionBroker;
  private readonly cancellation: CancellationCoordinator;
  private readonly actions: TuiControllerActions;
  private readonly music: TuiMusicController;
  private suspendTerminal?: SuspendTerminal;
  private exitUi?: (error?: Error) => void;
  private redrawUi?: () => void;
  private activeRun?: Promise<void>;
  private unsubscribeMusic?: () => void;
  private modelCatalogGeneration = 0;

  constructor(options: TuiControllerOptions) {
    this.runtime = options.runtime;
    this.store = options.store;
    this.permissions = options.permissions;
    this.cancellation = options.cancellation;
    this.actions = options.actions;
    this.music = options.music;
    this.store.setMusic(options.music.getState());
    this.unsubscribeMusic = options.music.subscribe((state) => {
      this.store.setMusic(state);
    });
  }

  bindApp(input: {
    exit(error?: Error): void;
    suspendTerminal: SuspendTerminal;
  }): void {
    this.exitUi = input.exit;
    this.suspendTerminal = input.suspendTerminal;
  }

  submit(input: string): void {
    const value = input.trim();
    if (value === "") return;
    if (this.activeRun !== undefined && !isPassiveCommand(value)) {
      if (value.startsWith("/")) {
        this.store.setStatus(
          "That command is unavailable during an active task; interrupt or wait for the next boundary",
        );
        return;
      }
      if (this.store.getSnapshot().queuedFollowUp !== undefined) {
        this.store.setStatus(
          "One follow-up is already queued; wait for the current run boundary",
        );
        return;
      }
      this.store.setQueuedFollowUp(value);
      this.store.appendActivity({
        id: `queued-${Date.now()}`,
        label: `Queued follow-up: ${value}`,
        status: "queued",
        timestamp: Date.now(),
      });
      return;
    }
    if (value.startsWith("/music")) {
      void this.runMusicCommand(value);
      return;
    }
    const command = parseInteractiveCommand(value);
    if (command === undefined) {
      this.startRun(value);
      return;
    }
    void this.runInteractiveCommand(command);
  }

  resolvePermission(choice: PermissionChoice): void {
    this.permissions.resolve(choice);
  }

  interrupt(): void {
    if (this.permissions.active) {
      this.permissions.resolve("deny");
      return;
    }
    if (this.activeRun !== undefined) {
      this.cancellation.onSigint();
      this.store.setStatus("Interrupting the active task…");
      return;
    }
    this.requestExit();
  }

  requestExit(error?: Error): void {
    if (this.activeRun !== undefined) this.cancellation.onSigint();
    this.exitUi?.(error);
  }

  bindRedraw(redraw: () => void): void {
    this.redrawUi = redraw;
  }

  redraw(): void {
    this.redrawUi?.();
    this.store.tick();
  }

  async confirmOverlaySelection(): Promise<void> {
    const overlay = this.store.getSnapshot().overlay;
    if (overlay?.type !== "models" && overlay?.type !== "sessions") return;
    const selected = overlay.items[overlay.selectedIndex];
    if (selected === undefined) return;
    this.store.setOverlay(undefined);
    if (overlay.type === "models") await this.selectModel(selected.id);
    else await this.resume(selected.id);
  }

  closeOverlay(): void {
    this.store.setOverlay(undefined);
    this.store.setFocus("input");
  }

  async musicKey(command: MusicCommand): Promise<void> {
    try {
      await this.music.execute(command);
    } catch (error) {
      this.store.setStatus(`Music: ${sanitizeError(error).message}`);
    }
  }

  async loadModelCatalog(): Promise<void> {
    const runtime = this.runtime;
    const generation = ++this.modelCatalogGeneration;
    this.store.beginModelCatalog(runtime.providerId, runtime.model);
    try {
      const models = await runtime.provider.listModels();
      if (
        generation !== this.modelCatalogGeneration ||
        runtime !== this.runtime
      )
        return;
      this.store.setModelCatalog(runtime.providerId, models);
    } catch (error) {
      if (
        generation !== this.modelCatalogGeneration ||
        runtime !== this.runtime
      )
        return;
      this.store.failModelCatalog(
        runtime.providerId,
        sanitizeError(error).message,
      );
    }
  }

  async shutdown(): Promise<void> {
    this.modelCatalogGeneration += 1;
    this.unsubscribeMusic?.();
    this.unsubscribeMusic = undefined;
    if (this.activeRun !== undefined) {
      this.cancellation.onSigint();
      await this.activeRun.catch(() => undefined);
    }
    await this.runtime.sessions.flush();
  }

  private startRun(task: string): void {
    if (this.activeRun !== undefined) return;
    this.store.startRun(task);
    this.activeRun = this.executeRun(task).finally(() => {
      this.activeRun = undefined;
      const queued = this.store.getSnapshot().queuedFollowUp;
      if (queued !== undefined) {
        this.store.setQueuedFollowUp(undefined);
        this.startRun(queued);
      }
    });
  }

  private async executeRun(task: string): Promise<void> {
    try {
      await this.cancellation.run(async (signal) => {
        await this.runtime.agent.run(task, { signal });
      });
      this.runtime.session = this.runtime.agent.session;
    } catch (error) {
      this.runtime.session = this.runtime.agent.session;
      if (isAbortError(error)) {
        if (this.store.getSnapshot().phase === "working") {
          this.store.finishRun("cancelled", "Task interrupted");
        }
      } else if (this.store.getSnapshot().phase === "working") {
        this.store.finishRun("failed", sanitizeError(error).message);
      }
    } finally {
      await this.runtime.sessions.flush().catch(() => undefined);
    }
  }

  private async runInteractiveCommand(
    command: NonNullable<ReturnType<typeof parseInteractiveCommand>>,
  ): Promise<void> {
    try {
      switch (command.name) {
        case "help":
          this.store.setOverlay({ type: "help" });
          return;
        case "login":
          await this.withSuspendedTerminal(async () => {
            this.replaceRuntime(
              await this.cancellation.run((signal) =>
                this.actions.login(signal, this.runtime),
              ),
            );
          });
          return;
        case "logout": {
          const removed = await this.actions.logout(this.runtime.providerId);
          this.store.setStatus(
            removed
              ? `Logged out from ${this.runtime.providerId}`
              : `No stored credential for ${this.runtime.providerId}`,
          );
          return;
        }
        case "model":
          if (command.model !== undefined)
            await this.selectModel(command.model);
          else await this.showModels();
          return;
        case "new":
          this.replaceRuntime(await this.actions.newSession(this.runtime));
          return;
        case "resume":
          if (command.sessionId !== undefined)
            await this.resume(command.sessionId);
          else await this.showSessions();
          return;
        case "sessions":
          await this.showSessions();
          return;
        case "music":
          await this.music.execute(command.command);
          return;
        case "compact": {
          this.store.setCompanion("thinking", "Compacting older context");
          await this.cancellation.run(async (signal) => {
            await this.runtime.agent.compact({ signal });
          });
          this.runtime.session = this.runtime.agent.session;
          this.store.setRuntime(this.runtime);
          this.store.setStatus("Context compaction finished");
          return;
        }
        case "status": {
          const state = this.runtime.agent.session;
          this.store.setStatus(
            `${this.runtime.providerId} · ${this.runtime.model} · ${state.id} · ${state.usage.inputTokens} in / ${state.usage.outputTokens} out`,
          );
          return;
        }
        case "clear":
          this.store.clearVisualHistory();
          return;
        case "exit":
          this.requestExit();
          return;
        case "unknown":
          this.store.setStatus(
            command.reason ?? `Unknown command: ${command.input}. Type /help.`,
          );
          return;
      }
    } catch (error) {
      this.store.setStatus(redactText(sanitizeError(error).message));
    }
  }

  private async showModels(): Promise<void> {
    await this.loadModelCatalog();
    const models = this.store.getSnapshot().modelCatalog.models;
    this.store.setOverlay({
      type: "models",
      title: "Select model",
      items: models.map((model) => ({
        id: model.id,
        label: model.id,
        ...(model.name === undefined ? {} : { detail: model.name }),
      })),
      selectedIndex: Math.max(
        0,
        models.findIndex((model) => model.id === this.runtime.model),
      ),
    });
  }

  private async showSessions(): Promise<void> {
    const sessions = await this.runtime.sessions.list();
    this.store.setOverlay({
      type: "sessions",
      title: "Resume session",
      items: sessions.map((session) => ({
        id: session.id,
        label: `${session.id} · ${session.status}`,
        detail: `${session.provider} · ${session.model}`,
      })),
      selectedIndex: Math.max(
        0,
        sessions.findIndex((session) => session.id === this.runtime.session.id),
      ),
    });
  }

  private async selectModel(model: string): Promise<void> {
    this.runtime.loop.setModel(model);
    await this.runtime.sessions.setModel(this.runtime.session.id, model);
    await this.actions.saveModel(this.runtime.providerId, model);
    this.runtime.model = model;
    this.runtime.session = await this.runtime.agent.refresh();
    this.store.setRuntime(this.runtime);
    this.store.setStatus(`Model: ${model}`);
  }

  private async resume(sessionId: string): Promise<void> {
    this.replaceRuntime(await this.actions.resume(sessionId));
    this.store.setStatus(`Resumed session ${sessionId}`);
  }

  private replaceRuntime(runtime: InteractiveRuntime): void {
    this.runtime = runtime;
    this.store.setRuntime(runtime);
    void this.loadModelCatalog();
  }

  private async runMusicCommand(input: string): Promise<void> {
    try {
      const command = parseMusicCommand(input);
      const state = await this.music.execute(command);
      this.store.setMusic(state);
      if (command.type === "status") this.store.setStatus(state.statusMessage);
    } catch (error) {
      this.store.setStatus(`Music: ${sanitizeError(error).message}`);
    }
  }

  private async withSuspendedTerminal(
    callback: () => Promise<void>,
  ): Promise<void> {
    if (this.suspendTerminal === undefined) {
      await callback();
      return;
    }
    await this.suspendTerminal(callback);
  }
}

export function parseMusicCommand(input: string): MusicCommand {
  const parts = input.trim().split(/\s+/u);
  const action = parts[1] ?? "status";
  const argument = parts.slice(2).join(" ");
  if (action === "library") {
    if (argument === "")
      throw new ConfigurationError("Usage: /music library <path>");
    return { type: "library", path: argument };
  }
  if (action === "seek") {
    const seconds = Number(argument);
    if (!Number.isFinite(seconds))
      throw new ConfigurationError("Usage: /music seek <seconds>");
    return { type: "seek", seconds };
  }
  if (action === "volume") {
    const volume = Number(argument);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new ConfigurationError("Usage: /music volume <0-100>");
    }
    return { type: "volume", volume };
  }
  if (
    [
      "play",
      "builtin",
      "pause",
      "toggle",
      "next",
      "previous",
      "shuffle",
      "repeat",
      "status",
    ].includes(action)
  ) {
    return { type: action } as MusicCommand;
  }
  throw new ConfigurationError(`Unknown music command: ${action}`);
}

function isPassiveCommand(input: string): boolean {
  return /^\/(?:help|status|clear|music)(?:\s|$)/u.test(input);
}
