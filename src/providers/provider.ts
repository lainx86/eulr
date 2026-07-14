import type { AgentMessage, JsonObject } from "../agent/messages.js";

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  description?: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ModelToolDefinition[];
  sessionId?: string;
}

export interface ModelStreamOptions {
  signal?: AbortSignal;
}

export type ModelEvent =
  | { type: "text_delta"; text: string; outputIndex?: number }
  | { type: "reasoning_delta"; text: string; outputIndex?: number }
  | {
      type: "provider_item";
      providerId: string;
      data: JsonObject;
      outputIndex?: number;
    }
  | {
      type: "tool_call_start";
      callId: string;
      toolName: string;
      outputIndex?: number;
    }
  | {
      type: "tool_call_delta";
      callId: string;
      argumentsDelta: string;
    }
  | { type: "tool_call_end"; callId: string }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    }
  | { type: "done"; finishReason: string };

export interface ModelProvider {
  readonly id: string;

  listModels(): Promise<ModelInfo[]>;

  stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent>;
}
