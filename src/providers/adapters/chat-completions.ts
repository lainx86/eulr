import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

import type { AgentMessage } from "../../agent/messages.js";
import type { ModelToolDefinition } from "../provider.js";

export function toChatMessages(
  systemPrompt: string,
  messages: readonly AgentMessage[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  if (systemPrompt.length > 0) {
    result.push({ role: "system", content: systemPrompt });
  }
  for (const message of messages) {
    if (message.role === "user") {
      result.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "tool") {
      result.push({
        role: "tool",
        tool_call_id: message.callId,
        content: message.content,
      });
      continue;
    }

    const text = message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
    const calls = message.content
      .filter((content) => content.type === "tool_call")
      .map((content) => ({
        id: content.callId,
        type: "function" as const,
        function: {
          name: content.toolName,
          arguments: serializeArguments(content.arguments),
        },
      }));
    const assistant: ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    };
    result.push(assistant);
  }
  return result;
}

export function toChatTools(
  tools: readonly ModelToolDefinition[],
): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    },
  }));
}

function serializeArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? "null";
}
