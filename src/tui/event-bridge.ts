import type { AgentEvent, AgentEventSink } from "../agent/events.js";
import type { TokenUsage } from "../agent/messages.js";
import { redactText } from "../auth/redaction.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../permissions/types.js";
import { CancellationError } from "../utils/errors.js";
import type {
  FileChangeState,
  FileViewState,
  OutputViewState,
} from "./types.js";
import { TuiStore } from "./state/tui-store.js";

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export type PermissionChoice = "allow_once" | "allow_session" | "deny";

/** Bridges PermissionManager's promise API to the retained TUI input region. */
export class TuiPermissionBroker {
  private pending?: PendingPermission;

  constructor(private readonly store: TuiStore) {}

  request = (
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> => {
    if (this.pending !== undefined) {
      return Promise.reject(
        new Error("A permission request is already awaiting a decision"),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new CancellationError("Permission request cancelled"),
      );
    }

    this.store.setPermission({ request: sanitizePermission(request) });
    return new Promise<PermissionDecision>((resolve, reject) => {
      const onAbort = (): void => {
        this.reject(new CancellationError("Permission request cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
    });
  };

  resolve(choice: PermissionChoice): boolean {
    const pending = this.pending;
    if (pending === undefined) return false;
    this.pending = undefined;
    pending.cleanup();
    this.store.setPermission(undefined);
    pending.resolve({
      allowed: choice !== "deny",
      remember: choice === "allow_session",
    });
    return true;
  }

  reject(error = new CancellationError("Permission request cancelled")): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    pending.cleanup();
    this.store.setPermission(undefined);
    pending.reject(error);
  }

  get active(): boolean {
    return this.pending !== undefined;
  }
}

/** Normalizes provider-independent agent events into display state. */
export class AgentTuiEventBridge {
  private baseUsage: TokenUsage;
  private taskUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };

  constructor(private readonly store: TuiStore) {
    this.baseUsage = { ...store.getSnapshot().usage };
  }

  readonly sink: AgentEventSink = (event) => this.handle(event);

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "task_started":
        this.baseUsage = { ...this.store.getSnapshot().usage };
        this.taskUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
        };
        this.store.setCompanion("thinking", "Thinking through the task");
        return;
      case "task_completed":
        this.store.setUsage(addUsage(this.baseUsage, event.usage));
        this.store.finishRun("completed", "Task completed");
        return;
      case "task_failed":
        this.store.setUsage(addUsage(this.baseUsage, event.usage));
        this.store.finishRun("failed", event.error);
        return;
      case "task_cancelled":
        this.store.setUsage(addUsage(this.baseUsage, event.usage));
        this.store.finishRun("cancelled", event.error);
        return;
      case "text_delta":
        this.store.appendAnswer(event.text);
        return;
      case "thinking":
        this.store.setCompanion("thinking", "Thinking through the task");
        return;
      case "project_instructions_loaded":
        this.store.appendActivity({
          id: `instructions-${Date.now()}`,
          label: `${event.reloaded ? "Reloaded" : "Loaded"} ${event.path}`,
          status: "completed",
          timestamp: Date.now(),
        });
        return;
      case "tool_started":
        this.handleToolStarted(event);
        return;
      case "tool_output":
        this.store.appendOutput(event.stream, event.chunk);
        return;
      case "tool_finished":
        this.handleToolFinished(event);
        return;
      case "usage":
        this.taskUsage = addUsage(this.taskUsage, event.usage);
        this.store.setUsage(addUsage(this.baseUsage, this.taskUsage));
        return;
    }
  }

  private handleToolStarted(
    event: Extract<AgentEvent, { type: "tool_started" }>,
  ): void {
    this.store.appendActivity({
      id: event.callId,
      callId: event.callId,
      toolName: event.toolName,
      label: `${toolVerb(event.toolName)} ${event.target}`,
      status: "active",
      timestamp: Date.now(),
    });

    if (event.toolName === "read") {
      this.store.setCompanion("reading", "Understanding the codebase");
    } else if (event.toolName === "write" || event.toolName === "edit") {
      this.store.setCompanion("editing", "Focused on writing code");
    } else if (event.toolName === "bash") {
      this.store.setCompanion("running", "Checking the result");
      this.store.startOutput(event.target);
    } else {
      this.store.setCompanion("thinking", `Using ${event.toolName}`);
    }
  }

  private handleToolFinished(
    event: Extract<AgentEvent, { type: "tool_finished" }>,
  ): void {
    this.store.updateActivity(event.callId, {
      status: event.isError ? "failed" : "completed",
      detail: event.summary,
    });

    const metadata = record(event.metadata);
    if (event.toolName === "read") {
      const file = parseFileView(metadata);
      if (file !== undefined) this.store.setFile(file);
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      const change = parseFileChange(metadata.fileChange);
      if (change !== undefined) this.store.setChange(change);
    }
    if (event.toolName === "bash") {
      const output = parseOutput(metadata);
      this.store.finishOutput(output);
    }

    this.store.setCompanion(
      event.isError ? "error" : "thinking",
      event.isError ? event.summary : "Continuing the task",
    );
  }
}

function parseFileView(
  metadata: Record<string, unknown>,
): FileViewState | undefined {
  if (
    typeof metadata.path !== "string" ||
    typeof metadata.preview !== "string"
  ) {
    return undefined;
  }
  return {
    path: metadata.path,
    content: metadata.preview,
    truncated: metadata.previewTruncated === true,
  };
}

function parseFileChange(value: unknown): FileChangeState | undefined {
  const change = record(value);
  if (
    typeof change.path !== "string" ||
    typeof change.after !== "string" ||
    !(typeof change.before === "string" || change.before === null)
  ) {
    return undefined;
  }
  return {
    path: change.path,
    before: change.before,
    after: change.after,
    truncated: change.truncated === true,
  };
}

function parseOutput(
  metadata: Record<string, unknown>,
): Partial<OutputViewState> {
  return {
    ...(typeof metadata.command === "string"
      ? { command: metadata.command }
      : {}),
    ...(typeof metadata.stdout === "string" ? { stdout: metadata.stdout } : {}),
    ...(typeof metadata.stderr === "string" ? { stderr: metadata.stderr } : {}),
    ...(typeof metadata.exitCode === "number" || metadata.exitCode === null
      ? { exitCode: metadata.exitCode }
      : {}),
    truncated:
      metadata.stdoutTruncated === true || metadata.stderrTruncated === true,
    running: false,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizePermission(request: PermissionRequest): PermissionRequest {
  return {
    ...request,
    target: redactText(request.target),
    ...(request.description === undefined
      ? {}
      : { description: redactText(request.description) }),
    ...(request.risk === undefined ? {} : { risk: redactText(request.risk) }),
  };
}

function toolVerb(toolName: string): string {
  if (toolName === "read") return "Reading";
  if (toolName === "write") return "Writing";
  if (toolName === "edit") return "Editing";
  if (toolName === "bash") return "Running";
  return "Using";
}

function addUsage(current: TokenUsage, update: TokenUsage): TokenUsage {
  return {
    inputTokens: current.inputTokens + update.inputTokens,
    outputTokens: current.outputTokens + update.outputTokens,
    cachedInputTokens: current.cachedInputTokens + update.cachedInputTokens,
  };
}
