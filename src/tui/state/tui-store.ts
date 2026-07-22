import type { TokenUsage } from "../../agent/messages.js";
import type { SessionState } from "../../sessions/state.js";
import type { ReasoningEffort } from "../../providers/provider.js";
import type {
  ActivityStatus,
  ActivityItem,
  CompanionState,
  FileChangeState,
  FileViewState,
  FocusTarget,
  InspectorTab,
  ModelCatalogItem,
  OutputViewState,
  OverlayState,
  RuntimeStatusUiState,
  RunPhase,
  TuiState,
} from "../types.js";
import {
  displayLine,
  displayOptionalLine,
  displayText,
} from "../display-text.js";

const MAX_ACTIVITIES = 500;
const MAX_ANSWER_CHARS = 200_000;
const MAX_VIEW_CHARS = 120_000;
const PINNED_TO_END = Number.MAX_SAFE_INTEGER;
const FOCUS_ORDER: FocusTarget[] = ["activity", "inspector", "input"];

export interface TuiStoreOptions {
  providerId: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  cwd: string;
  session: SessionState;
  version: string;
  authentication?: {
    method?: "chatgpt" | "api-key";
    account?: string;
    plan?: string;
  };
  autoApprove?: boolean;
  contextWindow?: number;
}

export class TuiStore {
  private state: TuiState;
  private readonly listeners = new Set<() => void>();

  constructor(options: TuiStoreOptions) {
    this.state = {
      providerId: options.providerId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      cwd: options.cwd,
      sessionId: options.session.id,
      version: options.version,
      idleView: "welcome",
      runtimeStatus: runtimeStatus(options.session, options),
      phase: sessionPhase(options.session),
      task: displayOptionalLine(latestUserMessage(options.session)),
      activities: sessionActivities(options.session).map(sanitizeActivity),
      inspector: {
        activeTab: "answer",
        manuallySelected: false,
        answer: displayText(latestAssistantText(options.session)),
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
    reasoningEffort?: ReasoningEffort;
    cwd: string;
    session: SessionState;
    authentication?: TuiStoreOptions["authentication"];
    autoApprove?: boolean;
    contextWindow?: number;
  }): void {
    const phase = sessionPhase(input.session);
    this.replace({
      ...this.state,
      providerId: input.providerId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      cwd: input.cwd,
      sessionId: input.session.id,
      runtimeStatus: runtimeStatus(input.session, input),
      phase,
      task: displayOptionalLine(latestUserMessage(input.session)),
      activities: sessionActivities(input.session).map(sanitizeActivity),
      inspector: {
        activeTab: "answer",
        manuallySelected: false,
        answer: displayText(latestAssistantText(input.session)),
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
      label: displayLine(task),
      status: "active",
      timestamp: Date.now(),
    };
    this.patch({
      phase: "working",
      idleView: "welcome",
      task: displayLine(task),
      activities: [...this.state.activities, activity].slice(-MAX_ACTIVITIES),
      inspector: {
        ...this.state.inspector,
        activeTab: "answer",
        manuallySelected: false,
        answer: "",
      },
      scroll: {
        ...this.state.scroll,
        activity: PINNED_TO_END,
        inspector: {
          ...this.state.scroll.inspector,
          answer: { vertical: PINNED_TO_END, horizontal: 0 },
        },
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
      statusMessage: displayLine(message),
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
      ...(message === undefined ? {} : { statusMessage: displayLine(message) }),
    });
  }

  appendActivity(item: ActivityItem): void {
    const currentRowCount = activityRowCount(this.state.activities);
    const wasPinned =
      this.state.scroll.activity === PINNED_TO_END ||
      this.state.scroll.activity >= currentRowCount - 1;
    this.patch({
      activities: [
        ...this.state.activities,
        {
          ...item,
          label: displayLine(item.label),
          detail: displayOptionalLine(item.detail),
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
                : { label: displayLine(update.label) }),
              ...(update.detail === undefined
                ? {}
                : { detail: displayLine(update.detail) }),
            }
          : item,
      ),
    });
  }

  appendAnswer(text: string): void {
    const answer = `${this.state.inspector.answer}${displayText(text)}`;
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
          path: displayLine(file.path),
          content: displayText(file.content).slice(0, MAX_VIEW_CHARS),
          truncated:
            file.truncated === true || file.content.length > MAX_VIEW_CHARS,
        },
        activeTab: this.autoTab("file", force),
      },
      scroll: {
        ...this.state.scroll,
        inspector: {
          ...this.state.scroll.inspector,
          file: { vertical: 0, horizontal: 0 },
        },
      },
    });
  }

  setChange(change: FileChangeState, force = false): void {
    this.patch({
      inspector: {
        ...this.state.inspector,
        change: {
          ...change,
          path: displayLine(change.path),
          before:
            change.before === null
              ? null
              : displayText(change.before).slice(0, MAX_VIEW_CHARS),
          after: displayText(change.after).slice(0, MAX_VIEW_CHARS),
          truncated:
            change.truncated === true ||
            (change.before?.length ?? 0) > MAX_VIEW_CHARS ||
            change.after.length > MAX_VIEW_CHARS,
        },
        activeTab: this.autoTab("changes", force),
      },
      scroll: {
        ...this.state.scroll,
        inspector: {
          ...this.state.scroll.inspector,
          changes: { vertical: 0, horizontal: 0 },
        },
      },
    });
  }

  startOutput(command: string): void {
    this.patch({
      inspector: {
        ...this.state.inspector,
        output: {
          command: displayLine(command),
          stdout: "",
          stderr: "",
          running: true,
        },
        activeTab: this.autoTab("output", false),
      },
      scroll: {
        ...this.state.scroll,
        inspector: {
          ...this.state.scroll.inspector,
          output: { vertical: PINNED_TO_END, horizontal: 0 },
        },
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
    const content = `${current[stream]}${displayText(chunk)}`;
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
        output: {
          ...current,
          ...sanitizeOutputUpdate(update),
          running: false,
        },
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
    this.patch({ queuedFollowUp: displayOptionalLine(message) });
  }

  setUsage(usage: TokenUsage): void {
    this.patch({ usage: { ...usage } });
  }

  showIdleStatus(input: {
    session: SessionState;
    authentication?: TuiStoreOptions["authentication"];
    autoApprove?: boolean;
    contextWindow?: number;
  }): void {
    this.patch({
      idleView: "status",
      usage: { ...input.session.usage },
      runtimeStatus: runtimeStatus(input.session, input),
      statusMessage: `Runtime status · ${this.state.providerId} · ${this.state.model}`,
    });
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
          id: displayLine(model.id),
          ...(model.name === undefined
            ? {}
            : { name: displayLine(model.name) }),
          ...(model.contextWindow === undefined
            ? {}
            : { contextWindow: model.contextWindow }),
          ...(model.defaultReasoningEffort === undefined
            ? {}
            : {
                defaultReasoningEffort: displayLine(
                  model.defaultReasoningEffort,
                ),
              }),
          ...(model.supportedReasoningEfforts === undefined
            ? {}
            : {
                supportedReasoningEfforts: model.supportedReasoningEfforts.map(
                  (option) => ({
                    effort: displayLine(option.effort),
                    ...(option.description === undefined
                      ? {}
                      : { description: displayLine(option.description) }),
                  }),
                ),
              }),
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
        error: displayLine(error),
      },
    });
  }

  setStatus(message: string): void {
    this.patch({ statusMessage: displayLine(message) });
  }

  setOverlay(overlay: OverlayState | undefined): void {
    this.patch({ overlay });
  }

  moveOverlaySelection(delta: number): void {
    const overlay = this.state.overlay;
    if (
      overlay?.type !== "models" &&
      overlay?.type !== "sessions" &&
      overlay?.type !== "reasoning"
    )
      return;
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

  scrollFocused(delta: number, horizontal = false, viewportHeight = 0): void {
    if (this.state.focus === "activity") {
      const current = this.state.scroll.activity;
      const rowCount = activityRowCount(this.state.activities);
      const endStart = Math.max(0, rowCount - Math.max(0, viewportHeight));
      const next =
        current === PINNED_TO_END
          ? delta < 0
            ? Math.max(0, endStart + delta)
            : PINNED_TO_END
          : Math.max(0, current + delta);
      this.patch({
        scroll: {
          ...this.state.scroll,
          activity: next >= endStart ? PINNED_TO_END : next,
        },
      });
      return;
    }
    if (this.state.focus !== "inspector") return;
    const tab = this.state.inspector.activeTab;
    const current = this.state.scroll.inspector[tab];
    const lineCount = inspectorLineCount(this.state, tab);
    const endStart = Math.max(0, lineCount - Math.max(0, viewportHeight));
    const nextVertical =
      current.vertical === PINNED_TO_END
        ? delta < 0
          ? Math.max(0, endStart + delta)
          : PINNED_TO_END
        : Math.max(0, current.vertical + delta);
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
            : {
                ...current,
                vertical:
                  nextVertical >= endStart ? PINNED_TO_END : nextVertical,
              },
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
      idleView: "welcome",
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

function runtimeStatus(
  session: SessionState,
  input: {
    authentication?: TuiStoreOptions["authentication"];
    autoApprove?: boolean;
    contextWindow?: number;
  },
): RuntimeStatusUiState {
  const activeMessages = session.messages.slice(session.compactedMessageCount);
  const serializedCharacters = activeMessages.reduce(
    (total, message) => total + JSON.stringify(message).length,
    session.contextSummary?.length ?? 0,
  );
  return {
    ...(input.authentication?.method === undefined
      ? {}
      : { authenticationMethod: input.authentication.method }),
    ...(input.authentication?.account === undefined
      ? {}
      : { account: displayLine(input.authentication.account) }),
    ...(input.authentication?.plan === undefined
      ? {}
      : { plan: displayLine(input.authentication.plan) }),
    permissionMode: input.autoApprove === true ? "auto" : "ask",
    sessionStatus: session.status,
    ...(input.contextWindow === undefined
      ? {}
      : { contextWindow: input.contextWindow }),
    estimatedContextTokens: Math.ceil(serializedCharacters / 4),
    activeMessages: activeMessages.length,
    compactedMessages: session.compactedMessageCount,
  };
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

function sanitizeActivity(item: ActivityItem): ActivityItem {
  return {
    ...item,
    label: displayLine(item.label),
    detail: displayOptionalLine(item.detail),
  };
}

function activityRowCount(activities: readonly ActivityItem[]): number {
  return activities.reduce(
    (count, activity) => count + 1 + (activity.detail === undefined ? 0 : 1),
    0,
  );
}

function inspectorLineCount(state: TuiState, tab: InspectorTab): number {
  if (tab === "file") {
    return lineCount(state.inspector.file?.content ?? "");
  }
  if (tab === "output") {
    const output = state.inspector.output;
    return output === undefined
      ? 0
      : lineCount(output.stdout) + lineCount(output.stderr);
  }
  if (tab === "answer") return lineCount(state.inspector.answer);
  const change = state.inspector.change;
  if (change === undefined) return 0;
  return lineCount(change.before ?? "") + lineCount(change.after);
}

function lineCount(value: string): number {
  return value === "" ? 0 : value.split("\n").length;
}

function sanitizeOutputUpdate(
  update: Partial<OutputViewState>,
): Partial<OutputViewState> {
  return {
    ...update,
    ...(update.command === undefined
      ? {}
      : { command: displayLine(update.command) }),
    ...(update.stdout === undefined
      ? {}
      : { stdout: displayText(update.stdout) }),
    ...(update.stderr === undefined
      ? {}
      : { stderr: displayText(update.stderr) }),
  };
}
