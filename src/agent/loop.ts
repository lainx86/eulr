import type { PermissionChecker } from "../permissions/types.js";
import type {
  ModelEvent,
  ModelProvider,
  ReasoningEffort,
} from "../providers/provider.js";
import type { SessionService } from "../sessions/session-service.js";
import type { SessionState } from "../sessions/state.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/tool.js";
import { redactText } from "../auth/redaction.js";
import {
  CancellationError,
  EulrError,
  ProviderError,
  errorMessage,
  isAbortError,
} from "../utils/errors.js";
import { compactContext } from "./compaction.js";
import { ContextManager } from "./context-manager.js";
import type { AgentEventSink } from "./events.js";
import { emptyUsage } from "./messages.js";
import type {
  AgentMessage,
  AssistantContent,
  JsonObject,
  TokenUsage,
} from "./messages.js";
import { ProjectInstructionLoader } from "./project-instructions.js";
import { createSystemPrompt } from "./system-prompt.js";

const DEFAULT_MAX_TURNS = 50;

interface PendingToolCall {
  callId: string;
  toolName: string;
  argumentsText: string;
  ended: boolean;
  outputIndex: number | undefined;
  sequence: number;
}

interface PendingProviderItem {
  providerId: string;
  data: JsonObject;
  outputIndex: number | undefined;
  sequence: number;
}

interface CollectedResponse {
  text: string;
  textOutputIndex: number | undefined;
  textSequence: number | undefined;
  reasoning: string;
  reasoningOutputIndex: number | undefined;
  reasoningSequence: number | undefined;
  providerItems: PendingProviderItem[];
  calls: PendingToolCall[];
  usage: TokenUsage;
  sawDone: boolean;
  nextSequence: number;
}

export interface AgentLoopOptions {
  provider: ModelProvider;
  model: string;
  reasoningEffort?: ReasoningEffort;
  tools: ToolRegistry;
  permissions: PermissionChecker;
  sessions: SessionService;
  context?: ContextManager;
  emit?: AgentEventSink;
  maxTurns?: number;
  now?: () => number;
}

export interface RunTaskOptions {
  signal?: AbortSignal;
}

export interface AgentRunResult {
  session: SessionState;
  finalText: string;
  turns: number;
  usage: TokenUsage;
}

export class AgentLoop {
  private readonly provider: ModelProvider;
  private model: string;
  private reasoningEffort: ReasoningEffort | undefined;
  private readonly tools: ToolRegistry;
  private readonly permissions: PermissionChecker;
  private readonly sessions: SessionService;
  private readonly context: ContextManager;
  private readonly emit: AgentEventSink;
  private readonly maxTurns: number;
  private readonly now: () => number;
  private readonly instructionLoaders = new Map<
    string,
    ProjectInstructionLoader
  >();

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.tools = options.tools;
    this.permissions = options.permissions;
    this.sessions = options.sessions;
    this.context = options.context ?? new ContextManager();
    this.emit = options.emit ?? (() => undefined);
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.now = options.now ?? Date.now;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setReasoningEffort(reasoningEffort: ReasoningEffort | undefined): void {
    this.reasoningEffort = reasoningEffort;
  }

  async runTask(
    initialSession: SessionState,
    instruction: string,
    options: RunTaskOptions = {},
  ): Promise<AgentRunResult> {
    const taskUsage = emptyUsage();
    let turns = 0;
    let session = initialSession;

    try {
      this.emit({ type: "task_started", sessionId: session.id });
      this.throwIfCancelled(options.signal);
      if (session.provider !== this.provider.id) {
        throw new ProviderError(
          `Session provider ${session.provider} does not match active provider ${this.provider.id}`,
        );
      }
      if (session.status !== "active") {
        await this.sessions.setStatus(session.id, "active");
      }
      const userMessage: AgentMessage = {
        role: "user",
        content: instruction,
        timestamp: this.now(),
      };
      await this.sessions.addMessage(session.id, userMessage);
      session = await this.sessions.load(session.id);

      let lastInputTokens: number | undefined;
      while (turns < this.maxTurns) {
        this.throwIfCancelled(options.signal);
        const project = await this.loadProjectInstructions(session);
        let systemPrompt = createSystemPrompt({
          cwd: session.cwd,
          projectInstructions: project,
          contextSummary: session.contextSummary,
        });

        if (
          this.context.shouldCompact(session, systemPrompt, {
            reportedInputTokens: lastInputTokens,
          })
        ) {
          const compacted = await compactContext({
            provider: this.provider,
            model: this.model,
            ...(this.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: this.reasoningEffort }),
            session,
            sessions: this.sessions,
            context: this.context,
            signal: options.signal,
            emit: this.emit,
          });
          if (compacted !== undefined) {
            addUsageInPlace(taskUsage, compacted.usage);
            session = await this.sessions.load(session.id);
            systemPrompt = createSystemPrompt({
              cwd: session.cwd,
              projectInstructions: project,
              contextSummary: session.contextSummary,
            });
          }
        }

        turns += 1;
        let collected: CollectedResponse;
        try {
          collected = await this.collectResponse(
            session,
            systemPrompt,
            options.signal,
          );
        } catch (error) {
          const partial = partialResponse(error);
          if (partial !== undefined && hasAssistantContent(partial)) {
            await this.persistAssistant(session.id, partial);
          }
          throw error;
        }

        addUsageInPlace(taskUsage, collected.usage);
        lastInputTokens = collected.usage.inputTokens || lastInputTokens;
        if (!collected.sawDone) {
          if (hasAssistantContent(collected)) {
            await this.persistAssistant(session.id, collected);
          }
          throw new ProviderError("Model stream ended without a final event");
        }

        await this.persistAssistant(session.id, collected);
        if (collected.calls.length === 0) {
          await this.sessions.setStatus(session.id, "completed");
          session = await this.sessions.load(session.id);
          this.emit({
            type: "task_completed",
            sessionId: session.id,
            turns,
            usage: { ...taskUsage },
          });
          return {
            session,
            finalText: collected.text,
            turns,
            usage: taskUsage,
          };
        }

        for (const call of collected.calls) {
          await this.executeToolCall(session, call, options.signal);
        }
        session = await this.sessions.load(session.id);
      }

      throw new ProviderError(
        `Maximum model turn limit reached (${this.maxTurns})`,
      );
    } catch (error) {
      const cancelled = options.signal?.aborted === true || isAbortError(error);
      await this.trySetStatus(session.id, cancelled ? "cancelled" : "failed");
      await this.sessions.flush();
      this.emit({
        type: cancelled ? "task_cancelled" : "task_failed",
        sessionId: session.id,
        turns,
        usage: { ...taskUsage },
        error: sanitizedTaskError(error, cancelled),
      });
      if (cancelled) {
        throw error instanceof CancellationError
          ? error
          : new CancellationError("Task was cancelled", { cause: error });
      }
      if (error instanceof EulrError) {
        throw error;
      }
      throw new ProviderError(errorMessage(error), { cause: error });
    }
  }

  async compactSession(
    session: SessionState,
    options: RunTaskOptions = {},
  ): Promise<SessionState> {
    this.throwIfCancelled(options.signal);
    await compactContext({
      provider: this.provider,
      model: this.model,
      ...(this.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.reasoningEffort }),
      session,
      sessions: this.sessions,
      context: this.context,
      signal: options.signal,
      force: true,
      emit: this.emit,
    });
    return this.sessions.load(session.id);
  }

  private async collectResponse(
    session: SessionState,
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<CollectedResponse> {
    const collected: CollectedResponse = {
      text: "",
      textOutputIndex: undefined,
      textSequence: undefined,
      reasoning: "",
      reasoningOutputIndex: undefined,
      reasoningSequence: undefined,
      providerItems: [],
      calls: [],
      usage: emptyUsage(),
      sawDone: false,
      nextSequence: 0,
    };
    const calls = new Map<string, PendingToolCall>();
    let announcedThinking = false;

    try {
      for await (const event of this.provider.stream(
        {
          model: this.model,
          ...(this.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: this.reasoningEffort }),
          systemPrompt,
          messages: this.context.messagesForRequest(session),
          tools: this.tools.definitions(),
          sessionId: session.id,
        },
        { signal },
      )) {
        this.throwIfCancelled(signal);
        this.applyModelEvent(collected, calls, event, () => {
          if (!announcedThinking) {
            announcedThinking = true;
            this.emit({ type: "thinking" });
          }
        });
      }
      return collected;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw withPartialResponse(
          new CancellationError("Model stream was cancelled", { cause: error }),
          collected,
        );
      }
      if (error instanceof ProviderError) {
        throw withPartialResponse(error, collected);
      }
      throw withPartialResponse(
        new ProviderError(`Model stream failed: ${errorMessage(error)}`, {
          cause: error,
        }),
        collected,
      );
    }
  }

  private applyModelEvent(
    collected: CollectedResponse,
    calls: Map<string, PendingToolCall>,
    event: ModelEvent,
    announceThinking: () => void,
  ): void {
    switch (event.type) {
      case "text_delta":
        if (collected.textSequence === undefined) {
          collected.textSequence = collected.nextSequence++;
          collected.textOutputIndex = event.outputIndex;
        }
        collected.text += event.text;
        this.emit({ type: "text_delta", text: event.text });
        break;
      case "reasoning_delta":
        if (collected.reasoningSequence === undefined) {
          collected.reasoningSequence = collected.nextSequence++;
          collected.reasoningOutputIndex = event.outputIndex;
        }
        collected.reasoning += event.text;
        announceThinking();
        break;
      case "provider_item":
        collected.providerItems.push({
          providerId: event.providerId,
          data: event.data,
          outputIndex: event.outputIndex,
          sequence: collected.nextSequence++,
        });
        announceThinking();
        break;
      case "tool_call_start": {
        if (calls.has(event.callId)) {
          throw new ProviderError(`Duplicate tool call ID: ${event.callId}`);
        }
        const call: PendingToolCall = {
          callId: event.callId,
          toolName: event.toolName,
          argumentsText: "",
          ended: false,
          outputIndex: event.outputIndex,
          sequence: collected.nextSequence++,
        };
        calls.set(event.callId, call);
        collected.calls.push(call);
        break;
      }
      case "tool_call_delta": {
        const call = calls.get(event.callId);
        if (call === undefined) {
          throw new ProviderError(
            `Received arguments for unknown tool call ${event.callId}`,
          );
        }
        if (call.ended) {
          throw new ProviderError(
            `Received arguments after tool call ${event.callId} ended`,
          );
        }
        call.argumentsText += event.argumentsDelta;
        break;
      }
      case "tool_call_end": {
        const call = calls.get(event.callId);
        if (call === undefined) {
          throw new ProviderError(`Unknown tool call ended: ${event.callId}`);
        }
        call.ended = true;
        break;
      }
      case "usage": {
        const usage: TokenUsage = {
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          cachedInputTokens: event.cachedInputTokens ?? 0,
        };
        addUsageInPlace(collected.usage, usage);
        this.emit({ type: "usage", usage });
        break;
      }
      case "done":
        collected.sawDone = true;
        break;
    }
  }

  private async persistAssistant(
    sessionId: string,
    response: CollectedResponse,
  ): Promise<void> {
    const ordered: Array<{
      content: AssistantContent;
      outputIndex: number | undefined;
      sequence: number;
    }> = [];
    if (response.text !== "") {
      ordered.push({
        content: { type: "text", text: response.text },
        outputIndex: response.textOutputIndex,
        sequence: response.textSequence ?? response.nextSequence++,
      });
    }
    if (response.reasoning !== "") {
      ordered.push({
        content: { type: "reasoning", text: response.reasoning },
        outputIndex: response.reasoningOutputIndex,
        sequence: response.reasoningSequence ?? response.nextSequence++,
      });
    }
    for (const item of response.providerItems) {
      ordered.push({
        content: {
          type: "provider_item",
          providerId: item.providerId,
          data: item.data,
        },
        outputIndex: item.outputIndex,
        sequence: item.sequence,
      });
    }
    for (const call of response.calls) {
      ordered.push({
        content: {
          type: "tool_call",
          callId: call.callId,
          toolName: call.toolName,
          arguments: parseArgumentsForHistory(call.argumentsText),
        },
        outputIndex: call.outputIndex,
        sequence: call.sequence,
      });
    }
    if (ordered.every((entry) => entry.outputIndex !== undefined)) {
      ordered.sort(
        (left, right) =>
          (left.outputIndex ?? 0) - (right.outputIndex ?? 0) ||
          left.sequence - right.sequence,
      );
    } else {
      ordered.sort((left, right) => left.sequence - right.sequence);
    }
    const content = ordered.map((entry) => entry.content);
    await this.sessions.addMessage(sessionId, {
      role: "assistant",
      content,
      timestamp: this.now(),
    });
    if (
      response.usage.inputTokens > 0 ||
      response.usage.outputTokens > 0 ||
      response.usage.cachedInputTokens > 0
    ) {
      await this.sessions.addUsage(sessionId, response.usage);
    }
  }

  private async executeToolCall(
    session: SessionState,
    call: PendingToolCall,
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfCancelled(signal);
    let input: unknown;
    let result: ToolResult | undefined;

    if (!call.ended) {
      input = call.argumentsText;
      result = {
        content: `Tool call ${call.toolName} ended before its arguments were complete.`,
        isError: true,
      };
    } else {
      try {
        input = JSON.parse(
          call.argumentsText === "" ? "{}" : call.argumentsText,
        );
      } catch {
        input = call.argumentsText;
        result = {
          content: `Malformed JSON arguments for tool ${call.toolName}.`,
          isError: true,
        };
      }
    }

    await this.sessions.toolStarted(
      session.id,
      call.callId,
      call.toolName,
      input,
    );
    this.emit({
      type: "tool_started",
      callId: call.callId,
      toolName: call.toolName,
      target: toolTarget(call.toolName, input),
      input,
    });

    if (result === undefined) {
      try {
        result = await this.tools.execute(call.toolName, input, {
          cwd: session.cwd,
          signal,
          permissions: this.permissions,
          onOutput: (stream, chunk) => {
            this.emit({
              type: "tool_output",
              callId: call.callId,
              toolName: call.toolName,
              stream,
              chunk,
            });
          },
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          throw new CancellationError(`Tool ${call.toolName} was cancelled`, {
            cause: error,
          });
        }
        result = {
          content: `Tool ${call.toolName} failed: ${errorMessage(error)}`,
          isError: true,
        };
      }
    }

    const isError = result.isError ?? false;
    await this.sessions.toolFinished(
      session.id,
      call.callId,
      call.toolName,
      result.content,
      isError,
    );
    await this.sessions.addMessage(session.id, {
      role: "tool",
      callId: call.callId,
      toolName: call.toolName,
      content: result.content,
      isError,
      timestamp: this.now(),
    });
    this.emit({
      type: "tool_finished",
      callId: call.callId,
      toolName: call.toolName,
      isError,
      summary: summarizeToolResult(result.content),
      content: result.content,
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    });
  }

  private async loadProjectInstructions(
    session: SessionState,
  ): Promise<string | undefined> {
    let loader = this.instructionLoaders.get(session.cwd);
    if (loader === undefined) {
      loader = new ProjectInstructionLoader(session.cwd);
      this.instructionLoaders.set(session.cwd, loader);
    }
    const result = await loader.load();
    if (result.changed && result.content !== undefined) {
      this.emit({
        type: "project_instructions_loaded",
        path: result.path,
        reloaded: result.reloaded,
      });
    }
    return result.content;
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new CancellationError("Task was cancelled", {
        cause: signal.reason,
      });
    }
  }

  private async trySetStatus(
    id: string,
    status: "failed" | "cancelled",
  ): Promise<void> {
    try {
      await this.sessions.setStatus(id, status);
    } catch {
      // Preserve the error that caused the task to stop.
    }
  }
}

function parseArgumentsForHistory(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText === "" ? "{}" : argumentsText);
  } catch {
    return argumentsText;
  }
}

function toolTarget(toolName: string, input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.path === "string") {
      return candidate.path;
    }
    if (typeof candidate.command === "string") {
      return candidate.command;
    }
  }
  return toolName;
}

function summarizeToolResult(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function sanitizedTaskError(error: unknown, cancelled: boolean): string {
  const message = redactText(errorMessage(error)).trim();
  if (message !== "") {
    return message;
  }
  return cancelled ? "Task was cancelled." : "Task failed.";
}

function addUsageInPlace(target: TokenUsage, update: TokenUsage): void {
  target.inputTokens += update.inputTokens;
  target.outputTokens += update.outputTokens;
  target.cachedInputTokens += update.cachedInputTokens;
}

function hasAssistantContent(response: CollectedResponse): boolean {
  return (
    response.text !== "" ||
    response.reasoning !== "" ||
    response.providerItems.length > 0 ||
    response.calls.length > 0
  );
}

function partialResponse(error: unknown): CollectedResponse | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as { eulrPartialResponse?: CollectedResponse })
    .eulrPartialResponse;
}

function withPartialResponse<T extends Error>(
  error: T,
  response: CollectedResponse,
): T {
  Object.defineProperty(error, "eulrPartialResponse", {
    value: response,
    configurable: true,
  });
  return error;
}
