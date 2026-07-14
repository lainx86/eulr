import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";

import type { ApiCredential } from "../auth/types.js";
import { redactText } from "../auth/redaction.js";
import {
  AuthenticationError,
  CancellationError,
  ProviderError,
} from "../utils/errors.js";
import { toChatMessages, toChatTools } from "./adapters/chat-completions.js";
import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelStreamOptions,
} from "./provider.js";

export interface ApiCredentialSource {
  getApiCredential(providerId?: string): Promise<ApiCredential>;
}

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  auth?: ApiCredentialSource;
  maxRetries?: number;
  clientFactory?: (options: ConstructorParameters<typeof OpenAI>[0]) => OpenAI;
}

interface ToolCallState {
  index: number;
  callId?: string;
  toolName?: string;
  arguments: string;
  started: boolean;
  ended: boolean;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly defaultModel?: string;
  private readonly auth?: ApiCredentialSource;
  private readonly maxRetries: number;
  private readonly clientFactory: (
    options: ConstructorParameters<typeof OpenAI>[0],
  ) => OpenAI;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.EULR_API_KEY;
    this.baseUrl = options.baseUrl ?? process.env.EULR_BASE_URL;
    this.defaultModel = options.model ?? process.env.EULR_MODEL;
    this.auth = options.auth;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.clientFactory =
      options.clientFactory ?? ((configuration) => new OpenAI(configuration));
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = await this.createClient();
    try {
      const models: ModelInfo[] = [];
      for await (const model of client.models.list()) {
        models.push({ id: model.id });
        if (models.length >= 500) {
          break;
        }
      }
      if (
        this.defaultModel !== undefined &&
        !models.some((model) => model.id === this.defaultModel)
      ) {
        models.push({ id: this.defaultModel });
      }
      models.sort((left, right) => left.id.localeCompare(right.id));
      return models;
    } catch (error) {
      if (
        this.defaultModel !== undefined &&
        isUnsupportedModelsEndpoint(error)
      ) {
        return [{ id: this.defaultModel }];
      }
      throw this.normalizeError(
        error,
        "Unable to list models from the compatible API",
      );
    }
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent> {
    const client = await this.createClient();
    const calls = new Map<number, ToolCallState>();
    let finishReason: string | undefined;
    try {
      const stream = await client.chat.completions.create(
        {
          model: request.model,
          messages: toChatMessages(request.systemPrompt, request.messages),
          ...(request.tools.length > 0
            ? {
                tools: toChatTools(request.tools),
                tool_choice: "auto" as const,
                parallel_tool_calls: true,
              }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options.signal },
      );

      for await (const chunk of stream) {
        if (options.signal?.aborted) {
          throw new CancellationError("Model request cancelled");
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          };
        }
        for (const choice of chunk.choices) {
          if (choice.delta.content) {
            yield { type: "text_delta", text: choice.delta.content };
          }
          for (const delta of choice.delta.tool_calls ?? []) {
            yield* applyToolDelta(delta, calls);
          }
          if (choice.finish_reason !== null) {
            finishReason = choice.finish_reason;
            if (calls.size > 0 && choice.finish_reason !== "tool_calls") {
              throw new ProviderError(
                `Compatible API ended with ${choice.finish_reason} before tool calls were finalized`,
              );
            }
            for (const state of calls.values()) {
              if (!state.started || state.callId === undefined) {
                throw new ProviderError(
                  "Compatible API returned an incomplete tool call",
                );
              }
              if (!state.ended) {
                state.ended = true;
                yield { type: "tool_call_end", callId: state.callId };
              }
            }
          }
        }
      }
    } catch (error) {
      if (
        error instanceof ProviderError ||
        error instanceof CancellationError
      ) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw new CancellationError("Model request cancelled", {
          cause: error,
        });
      }
      throw this.normalizeError(error, "Compatible API request failed");
    }

    if (finishReason === undefined) {
      throw new ProviderError(
        "Compatible API stream ended without a finish reason",
      );
    }
    yield { type: "done", finishReason };
  }

  private async createClient(): Promise<OpenAI> {
    let apiKey = this.apiKey;
    let baseUrl = this.baseUrl;
    if (apiKey === undefined && this.auth !== undefined) {
      const credential = await this.auth.getApiCredential(this.id);
      apiKey = credential.apiKey;
      baseUrl ??= credential.baseUrl;
    }
    if (apiKey === undefined || apiKey.length === 0) {
      throw new AuthenticationError(
        "No API key for openai-compatible. Run: eulr auth login or set EULR_API_KEY.",
      );
    }
    return this.clientFactory({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      maxRetries: this.maxRetries,
    });
  }

  private normalizeError(
    error: unknown,
    fallback: string,
  ): ProviderError | AuthenticationError {
    const status = errorStatus(error);
    if (status === 401 || status === 403) {
      return new AuthenticationError(
        `Compatible API rejected the credential (HTTP ${status}). Run: eulr auth login`,
        { cause: error },
      );
    }
    const message =
      error instanceof Error && error.message.length > 0
        ? redactText(error.message)
        : fallback;
    return new ProviderError(`${fallback}: ${message}`, { cause: error });
  }
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isUnsupportedModelsEndpoint(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 404 || status === 405 || status === 501;
}

async function* applyToolDelta(
  delta: NonNullable<ChatCompletionChunk.Choice.Delta["tool_calls"]>[number],
  calls: Map<number, ToolCallState>,
): AsyncGenerator<ModelEvent> {
  let state = calls.get(delta.index);
  if (state === undefined) {
    state = {
      index: delta.index,
      arguments: "",
      started: false,
      ended: false,
    };
    calls.set(delta.index, state);
  }
  state.callId ??= delta.id;
  state.toolName ??= delta.function?.name;

  if (
    !state.started &&
    state.callId !== undefined &&
    state.toolName !== undefined
  ) {
    state.started = true;
    yield {
      type: "tool_call_start",
      callId: state.callId,
      toolName: state.toolName,
    };
    if (state.arguments.length > 0) {
      yield {
        type: "tool_call_delta",
        callId: state.callId,
        argumentsDelta: state.arguments,
      };
    }
  }

  const argumentsDelta = delta.function?.arguments;
  if (argumentsDelta !== undefined && argumentsDelta.length > 0) {
    state.arguments += argumentsDelta;
    if (state.started && state.callId !== undefined) {
      yield {
        type: "tool_call_delta",
        callId: state.callId,
        argumentsDelta,
      };
    }
  }
}
