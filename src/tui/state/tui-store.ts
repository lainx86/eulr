import type { TokenUsage } from "../../agent/messages.js";
import { redactText } from "../../auth/redaction.js";
import type { SessionState } from "../../sessions/state.js";
import type {
  ActivityStatus,
  ActivityItem,
  CompanionState,
  FileChangeState,
  FileViewState,
  FocusTarget,
  InspectorTab,
  ModelCatalogItem,
  MusicUiState,
  OutputViewState,
  OverlayState,
  RunPhase,
  TuiState,
} from "../types.js";
import { emptyMusicUiState } from "../types.js";

const MAX_ACTIVITIES = 500;
const MAX_ANSWER_CHARS = 200_000;
const MAX_VIEW_CHARS = 120_000;
const PINNED_TO_END = Number.MAX_SAFE_INTEGER;
const FOCUS_ORDER: FocusTarget[] = ["activity", "inspector", "input", "music"];

export interface TuiStoreOptions {
  providerId: string;
  model: string;
  cwd: string;
  session: SessionState;
  version: string;
  music?: MusicUiState;
}

export class TuiStore {
  private state: TuiState;
  private readonly listeners = new Set<() => void>();

  constructor(options: TuiStoreOptions) {
    this.state = {
      providerId: options.providerId,
      model: options.model,
      cwd: options.cwd,
      sessionId: options.session.id,
      version: options.version,
      phase: sessionPhase(options.session),
      task: latestUserMessage(options.session),
      activities: sessionActivities(options.session),
      inspector: {
        activeTab: "answer",
        manuallySelected: false,
        answer: latestAssistantText(options.session),
      },
      companion: companionForPhase(sessionPhase(options.session)),
      focus: "input",
      statusMessage: statusForPhase(sessionPhase(options.session)),
      usage: { ...options.session.usage },
      modelCatalog: {
        providerId: options.providerId,
        status: "loading",
        models: [{ id: options.model }],
      },
      music: options.music ?? emptyMusicUiState(),
      scroll: {
        activity: PINNED_TO_END,
        inspector: {
          changes: { vertical: 0, horizontal: 0 },
          file: { vertical: 0, horizontal: 0 },
          output: { vertical: 0, horizontal: 0 },
          answer: { vertical: 0, horizontal: 0 },
        },
      },
      frame: 0,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): TuiState => this.state;

  setRuntime(input: {
    providerId: string;
    model: string;
    cwd: string;
    session: SessionState;
  }): void {
    const phase = sessionPhase(input.session);
    this.replace({
      ...this.state,
      providerId: input.providerId,
      model: input.model,
      cwd: input.cwd,
      sessionId: input.session.id,
      phase,
      task: latestUserMessage(input.session),
      activities: sessionActivities(input.session),
      inspector: {
        activeTab: "answer",
        manuallySelected: false,
        answer: latestAssistantText(input.session),
      },
      companion: companionForPhase(phase),
      statusMessage: statusForPhase(phase),
      usage: { ...input.session.usage },
      modelCatalog:
        input.providerId === this.state.modelCatalog.providerId
          ? this.state.modelCatalog
          : {
              providerId: input.providerId,
              status: "loading",
              models: [{ id: input.model }],
            },
      permission: undefined,
      queuedFollowUp: undefined,
      scroll: {
        ...this.state.scroll,
        activity: PINNED_TO_END,
      },
    });
  }

  startRun(task: string): void {
    const activity: ActivityItem = {
      id: `run-${Date.now()}-${this.state.frame}`,
      label: redactText(task),
      status: "active",
      timestamp: Date.now(),
    };
    this.patch({
      phase: "working",
      task: redactText(task),
      activities: [...this.state.activities, activity].slice(-MAX_ACTIVITIES),
      scroll: {
        ...this.state.scroll,
        activity: PINNED_TO_END,
      },
      inspector: {
        ...this.state.inspector,
        activeTab: "answer",
        manuallySelected: false,
        answer: "",
      },
      companion: "thinking",
      statusMessage: "Working on the active task",
      permission: undefined,
    });
  }

  finishRun(
    phase: Exclude<RunPhase, "idle" | "working">,
    message: string,
  ): void {
    const finalActivityStatus: ActivityStatus =
      phase === "completed"
        ? "completed"
        : phase === "cancelled"
          ? "cancelled"
          : "failed";
    const activities = this.state.activities.map((activity) =>
      activity.status === "active"
        ? {
            ...activity,
            status: finalActivityStatus,
          }
        : activity,
    );
    this.patch({
      phase,
      activities,
      companion: companionForPhase(phase),
      statusMessage: redactText(message),
      permission: undefined,
      focus: "input",
      inspector: {
        ...this.state.inspector,
        activeTab: "answer",
        manuallySelected: false,
      },
    });
  }

  setCompanion(companion: CompanionState, message?: string): void {
    this.patch({
      companion,
      ...(message === undefined ? {} : { statusMessage: redactText(message) }),
    });
  }

  appendActivity(item: ActivityItem): void {
    const wasPinned =
      this.state.scroll.activity === PINNED_TO_END ||
      this.state.scroll.activity >= this.state.activities.length - 1;
    this.patch({
      activities: [
        ...this.state.activities,
        {
          ...item,
          label: redactText(item.label),
          detail: redactOptional(item.detail),
        },
      ].slice(-MAX_ACTIVITIES),
      ...(wasPinned
        ? {
            scroll: {
              ...this.state.scroll,
              activity: PINNED_TO_END,
            },
          }
        : {}),
    });
  }

  updateActivity(id: string, update: Partial<ActivityItem>): void {
    this.patch({
      activities: this.state.activities.map((item) =>
        item.id === id
          ? {
              ...item,
              ...update,
              ...(update.label === undefined
                ? {}
                : { label: redactText(update.label) }),
              ...(update.detail === undefined
                ? {}
                : { detail: redactText(update.detail) }),
            }
          : item,
      ),
    });
  }

  appendAnswer(text: string): void {
    const answer = `${this.state.inspector.answer}${redactText(text)}`;
    this.patch({
      inspector: {
        ...this.state.inspector,
        answer: answer.slice(-MAX_ANSWER_CHARS),
      },
    });
  }

  setFile(file: FileViewState, force = false): void {
    this.patch({
      inspector: {
        ...this.state.inspector,
        file: {
          ...file,
          path: redactText(file.path),
          content: redactText(file.content).slice(0, MAX_VIEW_CHARS),
          truncated:
            file.truncated === true || file.content.length > MAX_VIEW_CHARS,
        },
        activeTab: this.autoTab("file", force),
      },
    });
  }

  setChange(change: FileChangeState, force = false): void {
    this.patch({
      inspector: {
        ...this.state.inspector,
        change: {
          ...change,
          path: redactText(change.path),
          before:
            change.before === null
              ? null
              : redactText(change.before).slice(0, MAX_VIEW_CHARS),
          after: redactText(change.after).slice(0, MAX_VIEW_CHARS),
          truncated:
            change.truncated === true ||
            (change.before?.length ?? 0) > MAX_VIEW_CHARS ||
            change.after.length > MAX_VIEW_CHARS,
        },
        activeTab: this.autoTab("changes", force),
      },
    });
  }

  startOutput(command: string): void {
    this.patch({
      inspector: {
        ...this.state.inspector,
        output: {
          command: redactText(command),
          stdout: "",
          stderr: "",
          running: true,
        },
        activeTab: this.autoTab("output", false),
      },
    });
  }

  appendOutput(stream: "stdout" | "stderr", chunk: string): void {
    const current = this.state.inspector.output ?? {
      command: "command",
      stdout: "",
      stderr: "",
      running: true,
    };
    const content = `${current[stream]}${redactText(chunk)}`;
    this.patch({
      inspector: {
        ...this.state.inspector,
        output: {
          ...current,
          [stream]: content.slice(-MAX_VIEW_CHARS),
          truncated:
            current.truncated === true || content.length > MAX_VIEW_CHARS,
        },
      },
    });
  }

  finishOutput(update: Partial<OutputViewState>): void {
    const current = this.state.inspector.output;
    if (current === undefined) return;
    this.patch({
      inspector: {
        ...this.state.inspector,
        output: { ...current, ...update, running: false },
      },
    });
  }

  selectInspector(tab: InspectorTab, manual = true): void {
    this.patch({
      inspector: {
        ...this.state.inspector,
        activeTab: tab,
        manuallySelected: manual,
      },
      focus: "inspector",
    });
  }

  cycleInspector(reverse = false): void {
    const tabs: InspectorTab[] = ["changes", "file", "output", "answer"];
    const index = tabs.indexOf(this.state.inspector.activeTab);
    const next = (index + (reverse ? tabs.length - 1 : 1)) % tabs.length;
    this.selectInspector(tabs[next] ?? "answer");
  }

  setPermission(permission: TuiState["permission"]): void {
    const leavingPermission =
      permission === undefined && this.state.companion === "waiting_permission";
    this.patch({
      permission,
      focus: "input",
      companion: permission
        ? "waiting_permission"
        : leavingPermission
          ? companionForPhase(this.state.phase)
          : this.state.companion,
      ...(permission
        ? { statusMessage: "Waiting for approval" }
        : leavingPermission
          ? { statusMessage: statusForPhase(this.state.phase) }
          : {}),
    });
  }

  setQueuedFollowUp(message: string | undefined): void {
    this.patch({ queuedFollowUp: redactOptional(message) });
  }

  setUsage(usage: TokenUsage): void {
    this.patch({ usage: { ...usage } });
  }

  beginModelCatalog(providerId: string, activeModel: string): void {
    const existing = this.state.modelCatalog;
    this.patch({
      modelCatalog: {
        providerId,
        status: "loading",
        models:
          existing.providerId === providerId && existing.models.length > 0
            ? existing.models
            : [{ id: activeModel }],
      },
    });
  }

  setModelCatalog(
    providerId: string,
    models: readonly ModelCatalogItem[],
  ): void {
    if (providerId !== this.state.providerId) return;
    this.patch({
      modelCatalog: {
        providerId,
        status: "ready",
        models: models.map((model) => ({
          id: redactText(model.id),
          ...(model.name === undefined ? {} : { name: redactText(model.name) }),
        })),
      },
    });
  }

  failModelCatalog(providerId: string, error: string): void {
    if (providerId !== this.state.providerId) return;
    const existing = this.state.modelCatalog;
    this.patch({
      modelCatalog: {
        providerId,
        status: "failed",
        models:
          existing.providerId === providerId && existing.models.length > 0
            ? existing.models
            : [{ id: this.state.model }],
        error: redactText(error),
      },
    });
  }

  setMusic(music: MusicUiState): void {
    this.patch({ music: sanitizeMusic(music) });
  }

  setStatus(message: string): void {
    this.patch({ statusMessage: redactText(message) });
  }

  setOverlay(overlay: OverlayState | undefined): void {
    this.patch({ overlay });
  }

  moveOverlaySelection(delta: number): void {
    const overlay = this.state.overlay;
    if (overlay?.type !== "models" && overlay?.type !== "sessions") return;
    if (overlay.items.length === 0) return;
    const selectedIndex =
      (overlay.selectedIndex + delta + overlay.items.length) %
      overlay.items.length;
    this.patch({ overlay: { ...overlay, selectedIndex } });
  }

  setFocus(focus: FocusTarget): void {
    this.patch({ focus });
  }

  cycleFocus(reverse = false): void {
    const current = FOCUS_ORDER.indexOf(this.state.focus);
    const next =
      (current + (reverse ? FOCUS_ORDER.length - 1 : 1)) % FOCUS_ORDER.length;
    this.patch({ focus: FOCUS_ORDER[next] ?? "input" });
  }

  scrollFocused(delta: number, horizontal = false): void {
    if (this.state.focus === "activity") {
      const current = this.state.scroll.activity;
      const next =
        current === PINNED_TO_END
          ? delta < 0
            ? Math.max(0, this.state.activities.length + delta)
            : PINNED_TO_END
          : Math.max(0, current + delta);
      this.patch({
        scroll: {
          ...this.state.scroll,
          activity: next >= this.state.activities.length ? PINNED_TO_END : next,
        },
      });
      return;
    }
    if (this.state.focus !== "inspector") return;
    const tab = this.state.inspector.activeTab;
    const current = this.state.scroll.inspector[tab];
    this.patch({
      scroll: {
        ...this.state.scroll,
        inspector: {
          ...this.state.scroll.inspector,
          [tab]: horizontal
            ? {
                ...current,
                horizontal: Math.max(0, current.horizontal + delta),
              }
            : { ...current, vertical: Math.max(0, current.vertical + delta) },
        },
      },
    });
  }

  scrollHome(): void {
    if (this.state.focus === "activity") {
      this.patch({ scroll: { ...this.state.scroll, activity: 0 } });
      return;
    }
    if (this.state.focus === "inspector") {
      const tab = this.state.inspector.activeTab;
      this.patch({
        scroll: {
          ...this.state.scroll,
          inspector: {
            ...this.state.scroll.inspector,
            [tab]: { vertical: 0, horizontal: 0 },
          },
        },
      });
    }
  }

  scrollEnd(): void {
    if (this.state.focus === "activity") {
      this.patch({
        scroll: { ...this.state.scroll, activity: PINNED_TO_END },
      });
      return;
    }
    if (this.state.focus === "inspector") {
      const tab = this.state.inspector.activeTab;
      const current = this.state.scroll.inspector[tab];
      this.patch({
        scroll: {
          ...this.state.scroll,
          inspector: {
            ...this.state.scroll.inspector,
            [tab]: { ...current, vertical: PINNED_TO_END },
          },
        },
      });
    }
  }

  clearVisualHistory(): void {
    this.patch({
      activities: [],
      inspector: {
        activeTab: "answer",
        manuallySelected: false,
        answer: "",
      },
      statusMessage: "Visual history cleared; session history is unchanged",
    });
  }

  tick(): void {
    this.patch({ frame: this.state.frame + 1 });
  }

  private autoTab(tab: InspectorTab, force: boolean): InspectorTab {
    return force || !this.state.inspector.manuallySelected
      ? tab
      : this.state.inspector.activeTab;
  }

  private patch(update: Partial<TuiState>): void {
    this.replace({ ...this.state, ...update });
  }

  private replace(next: TuiState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

function sessionPhase(session: SessionState): RunPhase {
  if (session.messages.length === 0 && session.toolExecutions.length === 0) {
    return "idle";
  }
  return session.status === "active" ? "idle" : session.status;
}

function latestUserMessage(session: SessionState): string | undefined {
  return [...session.messages]
    .reverse()
    .find((message) => message.role === "user")?.content;
}

function latestAssistantText(session: SessionState): string {
  const assistant = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (assistant?.role !== "assistant") return "";
  return assistant.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("");
}

function sessionActivities(session: SessionState): ActivityItem[] {
  return session.toolExecutions.slice(-MAX_ACTIVITIES).map((execution) => ({
    id: execution.callId,
    callId: execution.callId,
    toolName: execution.toolName,
    label: `${toolVerb(execution.toolName)} ${toolTarget(execution.input, execution.toolName)}`,
    status:
      execution.finishedAt === undefined
        ? "cancelled"
        : execution.isError
          ? "failed"
          : "completed",
    detail: execution.content?.split("\n", 1)[0],
    timestamp: execution.startedAt,
  }));
}

function toolTarget(input: unknown, fallback: string): string {
  if (typeof input !== "object" || input === null) return fallback;
  const record = input as Record<string, unknown>;
  if (typeof record.path === "string") return record.path;
  if (typeof record.command === "string") return record.command;
  return fallback;
}

function toolVerb(toolName: string): string {
  if (toolName === "read") return "Reading";
  if (toolName === "write") return "Writing";
  if (toolName === "edit") return "Editing";
  if (toolName === "bash") return "Running";
  return "Using";
}

function companionForPhase(phase: RunPhase): CompanionState {
  if (phase === "working") return "thinking";
  if (phase === "completed") return "completed";
  if (phase === "failed") return "error";
  if (phase === "cancelled") return "cancelled";
  return "idle";
}

function statusForPhase(phase: RunPhase): string {
  if (phase === "completed") return "Task completed";
  if (phase === "failed") return "Task needs attention";
  if (phase === "cancelled") return "Task interrupted";
  if (phase === "working") return "Working on the active task";
  return "eulr is idle and ready · No active task";
}

function redactOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactText(value);
}

function sanitizeMusic(music: MusicUiState): MusicUiState {
  return {
    ...music,
    statusMessage: redactText(music.statusMessage),
    ...(music.libraryPath === undefined
      ? {}
      : { libraryPath: redactText(music.libraryPath) }),
    ...(music.track === undefined
      ? {}
      : {
          track: {
            ...music.track,
            id: redactText(music.track.id),
            title: redactText(music.track.title),
            ...(music.track.artist === undefined
              ? {}
              : { artist: redactText(music.track.artist) }),
            ...(music.track.album === undefined
              ? {}
              : { album: redactText(music.track.album) }),
            ...(music.track.path === undefined
              ? {}
              : { path: redactText(music.track.path) }),
          },
        }),
  };
}
