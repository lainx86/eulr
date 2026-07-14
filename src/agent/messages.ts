export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "provider_item";
      providerId: string;
      data: JsonObject;
    }
  | {
      type: "tool_call";
      callId: string;
      toolName: string;
      arguments: unknown;
    };

export type AgentMessage =
  | { role: "user"; content: string; timestamp: number }
  | {
      role: "assistant";
      content: AssistantContent[];
      timestamp: number;
    }
  | {
      role: "tool";
      callId: string;
      toolName: string;
      content: string;
      isError: boolean;
      timestamp: number;
    };

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});

export function addUsage(
  target: TokenUsage,
  update: Partial<TokenUsage>,
): TokenUsage {
  return {
    inputTokens: target.inputTokens + (update.inputTokens ?? 0),
    outputTokens: target.outputTokens + (update.outputTokens ?? 0),
    cachedInputTokens:
      target.cachedInputTokens + (update.cachedInputTokens ?? 0),
  };
}
