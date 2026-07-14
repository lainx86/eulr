import type { AgentMessage, JsonObject } from "../../agent/messages.js";
import { redactText } from "../../auth/redaction.js";
import { CancellationError, ProviderError } from "../../utils/errors.js";
import type {
  ModelEvent,
  ModelRequest,
  ModelToolDefinition,
} from "../provider.js";

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  strict: false;
  parameters: Record<string, unknown>;
}

export type ResponsesInputItem = Record<string, unknown>;

export interface ResponsesRequestBody {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesFunctionTool[];
  tool_choice: "auto";
  parallel_tool_calls: boolean;
  store: false;
  stream: true;
  include: ["reasoning.encrypted_content"];
  prompt_cache_key?: string;
}

export function buildResponsesRequest(
  request: ModelRequest,
): ResponsesRequestBody {
  return {
    model: request.model,
    ...(request.systemPrompt.length > 0
      ? { instructions: request.systemPrompt }
      : {}),
    input: toResponsesInput(request.messages),
    ...(request.tools.length > 0
      ? { tools: request.tools.map(toResponsesTool) }
      : {}),
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    ...(request.sessionId ? { prompt_cache_key: request.sessionId } : {}),
  };
}

function toResponsesTool(tool: ModelToolDefinition): ResponsesFunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    strict: false,
    parameters: tool.inputSchema,
  };
}

export function toResponsesInput(
  messages: readonly AgentMessage[],
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      });
      continue;
    }
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.callId,
        output: message.content,
      });
      continue;
    }

    let pendingText = "";
    const flushText = (): void => {
      if (pendingText.length === 0) {
        return;
      }
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: pendingText }],
      });
      pendingText = "";
    };

    for (const content of message.content) {
      if (content.type === "text") {
        pendingText += content.text;
      } else if (content.type === "provider_item") {
        flushText();
        if (
          content.providerId === "openai-codex" &&
          content.data.type === "reasoning" &&
          typeof content.data.encrypted_content === "string"
        ) {
          items.push({ ...content.data });
        }
      } else if (content.type === "tool_call") {
        flushText();
        items.push({
          type: "function_call",
          call_id: content.callId,
          name: content.toolName,
          arguments: serializeArguments(content.arguments),
        });
      }
    }
    flushText();
  }
  return items;
}

function serializeArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

export interface ServerSentEvent {
  event?: string;
  data: string;
}

export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw new CancellationError("Model request cancelled");
      }
      const chunk = await reader.read();
      if (signal?.aborted) {
        throw new CancellationError("Model request cancelled");
      }
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const boundary = findEventBoundary(buffer);
        if (boundary === undefined) {
          break;
        }
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseEventBlock(block);
        if (event !== undefined) {
          yield event;
        }
      }
    }
    if (buffer.trim().length > 0) {
      const event = parseEventBlock(buffer);
      if (event !== undefined) {
        yield event;
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new CancellationError("Model request cancelled", { cause: error });
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function findEventBoundary(
  content: string,
): { index: number; length: number } | undefined {
  const match = /(?:\r\n\r\n|\n\n|\r\r)/.exec(content);
  return match?.index === undefined
    ? undefined
    : { index: match.index, length: match[0].length };
}

function parseEventBlock(block: string): ServerSentEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return { ...(event ? { event } : {}), data: data.join("\n") };
}

interface ToolStreamState {
  callId: string;
  toolName: string;
  arguments: string;
  started: boolean;
  ended: boolean;
  itemId?: string;
  outputIndex?: number;
}

export async function* normalizeResponsesStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ModelEvent> {
  const callsById = new Map<string, ToolStreamState>();
  const callIdByItem = new Map<string, string>();

  for await (const frame of parseServerSentEvents(body, signal)) {
    if (frame.data === "[DONE]") {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(frame.data);
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = stringValue(event.type) ?? frame.event;

    if (type === "response.output_text.delta") {
      const delta = stringValue(event.delta);
      if (delta !== undefined) {
        yield {
          type: "text_delta",
          text: delta,
          ...(numberValue(event.output_index) === undefined
            ? {}
            : { outputIndex: numberValue(event.output_index) }),
        };
      }
      continue;
    }
    if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta"
    ) {
      const delta = stringValue(event.delta);
      if (delta !== undefined) {
        yield {
          type: "reasoning_delta",
          text: delta,
          ...(numberValue(event.output_index) === undefined
            ? {}
            : { outputIndex: numberValue(event.output_index) }),
        };
      }
      continue;
    }
    if (type === "response.output_item.added") {
      const item = recordValue(event.item);
      if (item !== undefined && stringValue(item.type) === "function_call") {
        const state = createToolState(item, numberValue(event.output_index));
        if (state !== undefined) {
          callsById.set(state.callId, state);
          if (state.itemId !== undefined) {
            callIdByItem.set(state.itemId, state.callId);
          }
          state.started = true;
          yield {
            type: "tool_call_start",
            callId: state.callId,
            toolName: state.toolName,
            ...(state.outputIndex === undefined
              ? {}
              : { outputIndex: state.outputIndex }),
          };
        }
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const state = findToolState(event, callsById, callIdByItem);
      const delta = stringValue(event.delta);
      if (state !== undefined && delta !== undefined) {
        state.arguments += delta;
        yield {
          type: "tool_call_delta",
          callId: state.callId,
          argumentsDelta: delta,
        };
      }
      continue;
    }
    if (type === "response.output_item.done") {
      const item = recordValue(event.item);
      if (
        item !== undefined &&
        stringValue(item?.type) === "reasoning" &&
        stringValue(item?.encrypted_content) !== undefined
      ) {
        yield {
          type: "provider_item",
          providerId: "openai-codex",
          data: copyJsonObject(item),
          ...(numberValue(event.output_index) === undefined
            ? {}
            : { outputIndex: numberValue(event.output_index) }),
        };
        continue;
      }
      if (stringValue(item?.type) !== "function_call") {
        continue;
      }
      const callId = stringValue(item?.call_id);
      const toolName = stringValue(item?.name);
      if (callId === undefined || toolName === undefined) {
        throw new ProviderError("Codex returned an incomplete tool call");
      }
      let state = callsById.get(callId);
      if (state === undefined) {
        state = {
          callId,
          toolName,
          arguments: "",
          started: true,
          ended: false,
          ...(numberValue(event.output_index) === undefined
            ? {}
            : { outputIndex: numberValue(event.output_index) }),
        };
        callsById.set(callId, state);
        yield {
          type: "tool_call_start",
          callId,
          toolName,
          ...(state.outputIndex === undefined
            ? {}
            : { outputIndex: state.outputIndex }),
        };
      }
      const finalArguments = stringValue(item?.arguments) ?? "";
      if (finalArguments !== state.arguments) {
        if (finalArguments.startsWith(state.arguments)) {
          const suffix = finalArguments.slice(state.arguments.length);
          if (suffix.length > 0) {
            state.arguments += suffix;
            yield {
              type: "tool_call_delta",
              callId,
              argumentsDelta: suffix,
            };
          }
        } else {
          throw new ProviderError(
            `Codex streamed inconsistent arguments for tool call ${callId}`,
          );
        }
      }
      if (!state.ended) {
        state.ended = true;
        yield { type: "tool_call_end", callId };
      }
      continue;
    }
    if (type === "response.completed") {
      const response = recordValue(event.response) ?? event;
      const usage = recordValue(response.usage);
      if (usage !== undefined) {
        const inputDetails = recordValue(usage.input_tokens_details);
        yield {
          type: "usage",
          inputTokens: numberValue(usage.input_tokens),
          outputTokens: numberValue(usage.output_tokens),
          cachedInputTokens: numberValue(inputDetails?.cached_tokens),
        };
      }
      for (const state of callsById.values()) {
        if (state.started && !state.ended) {
          throw new ProviderError(
            `Codex completed before tool call ${state.callId} was finalized`,
          );
        }
      }
      yield {
        type: "done",
        finishReason: response.end_turn === false ? "tool_calls" : "stop",
      };
      return;
    }
    if (
      type === "response.failed" ||
      type === "response.incomplete" ||
      type === "error"
    ) {
      throw new ProviderError(responseFailureMessage(type, event));
    }
  }

  throw new ProviderError("Codex stream closed before response.completed");
}

function createToolState(
  item: Record<string, unknown>,
  outputIndex: number | undefined,
): ToolStreamState | undefined {
  const callId = stringValue(item.call_id);
  const toolName = stringValue(item.name);
  if (callId === undefined || toolName === undefined) {
    return undefined;
  }
  return {
    callId,
    toolName,
    arguments: "",
    started: false,
    ended: false,
    itemId: stringValue(item.id),
    ...(outputIndex === undefined ? {} : { outputIndex }),
  };
}

function findToolState(
  event: Record<string, unknown>,
  byCallId: Map<string, ToolStreamState>,
  callIdByItem: Map<string, string>,
): ToolStreamState | undefined {
  const direct = stringValue(event.call_id);
  if (direct !== undefined) {
    return byCallId.get(direct);
  }
  const itemId = stringValue(event.item_id);
  const callId = itemId === undefined ? undefined : callIdByItem.get(itemId);
  return callId === undefined ? undefined : byCallId.get(callId);
}

function responseFailureMessage(
  type: string,
  event: Record<string, unknown>,
): string {
  const response = recordValue(event.response);
  const error = recordValue(response?.error) ?? recordValue(event.error);
  const message = stringValue(error?.message) ?? stringValue(event.message);
  return message === undefined
    ? `Codex request ended with ${type}`
    : `Codex request failed: ${redactText(message)}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function copyJsonObject(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const copied = copyJsonValue(entry);
    if (copied !== undefined) {
      result[key] = copied;
    }
  }
  return result;
}

function copyJsonValue(value: unknown): JsonObject[string] | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonObject[string][] = [];
    for (const entry of value) {
      const copied = copyJsonValue(entry);
      if (copied !== undefined) {
        result.push(copied);
      }
    }
    return result;
  }
  const record = recordValue(value);
  return record === undefined ? undefined : copyJsonObject(record);
}
