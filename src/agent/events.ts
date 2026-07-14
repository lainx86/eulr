import type { TokenUsage } from "./messages.js";

export type AgentEvent =
  | { type: "task_started"; sessionId?: string }
  | {
      type: "task_completed";
      sessionId: string;
      turns: number;
      usage: TokenUsage;
    }
  | {
      type: "task_failed";
      sessionId: string;
      turns: number;
      usage: TokenUsage;
      error: string;
    }
  | {
      type: "task_cancelled";
      sessionId: string;
      turns: number;
      usage: TokenUsage;
      error: string;
    }
  | { type: "text_delta"; text: string }
  | { type: "thinking" }
  | { type: "project_instructions_loaded"; path: string; reloaded: boolean }
  | {
      type: "tool_started";
      callId: string;
      toolName: string;
      target: string;
      input: unknown;
    }
  | {
      type: "tool_output";
      callId: string;
      toolName: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      type: "tool_finished";
      callId: string;
      toolName: string;
      isError: boolean;
      summary: string;
      content: string;
      metadata?: Record<string, unknown>;
    }
  | { type: "usage"; usage: TokenUsage };

export type AgentEventSink = (event: AgentEvent) => void;
