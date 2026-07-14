import { addUsage, emptyUsage } from "../agent/messages.js";
import type { AgentMessage, TokenUsage } from "../agent/messages.js";
import type { SessionEvent, SessionStatus } from "./events.js";

export interface ToolExecutionState {
  callId: string;
  toolName: string;
  input: unknown;
  startedAt: number;
  finishedAt?: number;
  content?: string;
  isError?: boolean;
}

export interface SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  provider: string;
  model: string;
  status: SessionStatus;
  messages: AgentMessage[];
  toolExecutions: ToolExecutionState[];
  usage: TokenUsage;
  contextSummary?: string;
  compactedMessageCount: number;
}

export function reconstructSession(
  events: readonly SessionEvent[],
): SessionState {
  const created = events[0];
  if (created?.type !== "session_created") {
    throw new Error("Session event log must begin with session_created");
  }

  const state: SessionState = {
    id: created.sessionId,
    createdAt: created.timestamp,
    updatedAt: created.timestamp,
    cwd: created.cwd,
    provider: created.provider,
    model: created.model,
    status: "active",
    messages: [],
    toolExecutions: [],
    usage: emptyUsage(),
    compactedMessageCount: 0,
  };
  const executions = new Map<string, ToolExecutionState>();

  for (const event of events.slice(1)) {
    state.updatedAt = Math.max(state.updatedAt, event.timestamp);

    switch (event.type) {
      case "session_created":
        throw new Error(
          "Session event log contains more than one session_created event",
        );
      case "message_added":
        state.messages.push(event.message);
        break;
      case "tool_execution_started": {
        const execution: ToolExecutionState = {
          callId: event.callId,
          toolName: event.toolName,
          input: event.input,
          startedAt: event.timestamp,
        };
        executions.set(event.callId, execution);
        state.toolExecutions.push(execution);
        break;
      }
      case "tool_execution_finished": {
        const execution = executions.get(event.callId);
        if (execution !== undefined) {
          execution.finishedAt = event.timestamp;
          execution.content = event.content;
          execution.isError = event.isError;
        }
        break;
      }
      case "usage_updated":
        state.usage = addUsage(state.usage, event.usage);
        break;
      case "context_compacted":
        state.contextSummary = event.summary;
        state.compactedMessageCount = Math.min(
          event.compactedMessageCount,
          state.messages.length,
        );
        break;
      case "session_status_changed":
        state.status = event.status;
        break;
      case "session_model_changed":
        state.model = event.model;
        break;
    }
  }

  return state;
}

export function pendingToolCalls(state: SessionState): Array<{
  callId: string;
  toolName: string;
}> {
  const completed = new Set(
    state.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.callId),
  );
  const calls: Array<{ callId: string; toolName: string }> = [];

  for (const message of state.messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const content of message.content) {
      if (content.type === "tool_call" && !completed.has(content.callId)) {
        calls.push({ callId: content.callId, toolName: content.toolName });
      }
    }
  }

  return calls;
}
