import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ChatGPTCredential } from "../auth/types.js";
import {
  AuthenticationError,
  CancellationError,
  ProviderError,
} from "../utils/errors.js";
import { redactText } from "../auth/redaction.js";
import {
  buildResponsesRequest,
  normalizeResponsesStream,
} from "./adapters/responses.js";
import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelStreamOptions,
} from "./provider.js";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Whole Codex release version used for backend protocol compatibility.
 * Verified against openai/codex@5bed6447998c754d154dbd796517310b8f04d4ce
 * and its rust-v0.144.4 release baseline. This is independent of eulr's
 * package version.
 */
export const CODEX_PROTOCOL_COMPATIBILITY_VERSION = "0.144.4";

const RESPONSE_SUMMARY_LIMIT = 512;
const SEMANTIC_VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const reasoningEffortSchema = z.string().min(1);
const reasoningEffortPresetSchema = z.object({
  effort: reasoningEffortSchema,
  description: z.string().optional(),
});

export interface ChatGPTCredentialSource {
  getValidChatGPTCredential(signal?: AbortSignal): Promise<ChatGPTCredential>;
  forceRefreshChatGPT(
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<ChatGPTCredential>;
}

export interface OpenAICodexProviderOptions {
  auth: ChatGPTCredentialSource;
  fetch?: typeof fetch;
  baseUrl?: string;
  protocolCompatibilityVersion?: string;
  configuredModel?: string;
  onWarning?: (message: string) => void;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const modelSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().optional(),
  description: z.string().optional(),
  context_window: z.number().int().positive().optional(),
  default_reasoning_level: reasoningEffortSchema.optional(),
  supported_reasoning_levels: z
    .array(reasoningEffortPresetSchema)
    .default([]),
  visibility: z.enum(["list", "hide", "none"]),
  minimal_client_version: z.union([
    z.string().regex(SEMANTIC_VERSION_PATTERN),
    z.tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
    ]),
  ]),
  priority: z.number().int(),
});

const modelsResponseSchema = z.object({
  models: z.array(modelSchema),
});

export class OpenAICodexProvider implements ModelProvider {
  readonly id = "openai-codex";
  private readonly auth: ChatGPTCredentialSource;
  private readonly request: typeof fetch;
  private readonly baseUrl: string;
  private readonly protocolCompatibilityVersion: string;
  private readonly configuredModel: string | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  private lastSuccessfulCatalog: ModelInfo[] | undefined;

  constructor(options: OpenAICodexProviderOptions) {
    this.auth = options.auth;
    this.request = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? CODEX_BASE_URL;
    this.protocolCompatibilityVersion =
      options.protocolCompatibilityVersion ??
      CODEX_PROTOCOL_COMPATIBILITY_VERSION;
    assertSemanticVersion(
      this.protocolCompatibilityVersion,
      "Codex protocol compatibility version",
    );
    this.configuredModel = options.configuredModel;
    this.onWarning = options.onWarning;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 200);
    this.sleep = options.sleep ?? abortableDelay;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const url = this.endpoint("models");
      url.searchParams.set("client_version", this.protocolCompatibilityVersion);
      const response = await this.fetchAuthenticated(url, "GET");
      const parsed = await parseModelCatalogResponse(response);
      const models = parsed.models
        .filter(
          (model) =>
            model.visibility === "list" &&
            compareSemanticVersions(
              normalizeCatalogVersion(model.minimal_client_version),
              this.protocolCompatibilityVersion,
            ) <= 0,
        )
        .sort((left, right) => left.priority - right.priority)
        .map((model) => ({
          id: model.slug,
          ...(model.display_name ? { name: model.display_name } : {}),
          ...(model.description ? { description: model.description } : {}),
          ...(model.context_window
            ? { contextWindow: model.context_window }
            : {}),
          ...(model.default_reasoning_level === undefined
            ? {}
            : { defaultReasoningEffort: model.default_reasoning_level }),
          ...(model.supported_reasoning_levels.length === 0
            ? {}
            : {
                supportedReasoningEfforts:
                  model.supported_reasoning_levels.map((option) => ({
                    effort: option.effort,
                    ...(option.description === undefined
                      ? {}
                      : { description: option.description }),
                  })),
              }),
        }));
      this.lastSuccessfulCatalog = cloneModelList(models);
      return cloneModelList(models);
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof CancellationError ||
        !(error instanceof ProviderError)
      ) {
        throw error;
      }
      const detail = redactText(error.message);
      if (this.lastSuccessfulCatalog !== undefined) {
        this.warn(
          `Using the cached Codex model catalog because refresh failed: ${detail}`,
        );
        return cloneModelList(this.lastSuccessfulCatalog);
      }
      if (this.configuredModel !== undefined) {
        this.warn(
          `Using explicitly configured Codex model ${this.configuredModel} because catalog refresh failed: ${detail}`,
        );
        return [{ id: this.configuredModel }];
      }
      throw error;
    }
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent> {
    const body = JSON.stringify(buildResponsesRequest(request));
    const response = await this.fetchAuthenticated(
      this.endpoint("responses"),
      "POST",
      body,
      options.signal,
      request.sessionId,
    );
    if (response.body === null) {
      throw new ProviderError("Codex response did not include a stream body");
    }
    try {
      yield* normalizeResponsesStream(response.body, options.signal);
    } catch (error) {
      if (
        error instanceof ProviderError ||
        error instanceof AuthenticationError ||
        error instanceof CancellationError
      ) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw new CancellationError("Codex request cancelled", {
          cause: error,
        });
      }
      throw new ProviderError(
        `Codex streaming failed: ${redactText(error instanceof Error ? error.message : String(error))}`,
        { cause: error },
      );
    }
  }

  private endpoint(pathname: string): URL {
    return new URL(pathname, `${this.baseUrl.replace(/\/+$/, "")}/`);
  }

  private async fetchAuthenticated(
    url: URL,
    method: "GET" | "POST",
    body?: string,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<Response> {
    let credential = await this.auth.getValidChatGPTCredential(signal);
    let refreshed = false;
    let lastError: unknown;
    let attempt = 1;
    while (attempt <= this.maxAttempts) {
      if (signal?.aborted) {
        throw new CancellationError("Codex request cancelled");
      }
      let response: Response;
      try {
        response = await this.request(url, {
          method,
          headers: this.headers(
            credential,
            sessionId,
            method === "GET" ? "application/json" : "text/event-stream",
          ),
          ...(body === undefined ? {} : { body }),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new CancellationError("Codex request cancelled", {
            cause: error,
          });
        }
        lastError = error;
        if (attempt < this.maxAttempts) {
          await this.retryDelay(attempt, signal);
          attempt += 1;
          continue;
        }
        throw new ProviderError("Unable to connect to the Codex service", {
          cause: error,
        });
      }

      if (response.status === 401 && !refreshed) {
        await response.body?.cancel().catch(() => undefined);
        try {
          credential = await this.auth.forceRefreshChatGPT(
            signal,
            credential.accessToken,
          );
        } catch (error) {
          if (error instanceof CancellationError || signal?.aborted) {
            throw error;
          }
          throw new AuthenticationError(
            `Codex credential refresh failed after HTTP 401. Run: eulr auth login. ${redactText(error instanceof Error ? error.message : String(error))}`,
            { cause: error },
          );
        }
        refreshed = true;
        continue;
      }
      if (response.ok) {
        return response;
      }
      if (response.status >= 500 && attempt < this.maxAttempts) {
        await response.body?.cancel().catch(() => undefined);
        await this.retryDelay(attempt, signal);
        attempt += 1;
        continue;
      }
      const summary = await sanitizedResponseSummary(response);
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(
          `Codex rejected the ChatGPT credential (HTTP ${response.status}): ${summary}. Run: eulr auth login`,
        );
      }
      if (response.status === 429) {
        throw new ProviderError(
          `Codex rate limit reached (HTTP 429): ${summary}. Wait and try again.`,
        );
      }
      throw new ProviderError(
        `Codex request failed (HTTP ${response.status}): ${summary}`,
      );
    }
    throw new ProviderError("Unable to connect to the Codex service", {
      cause: lastError,
    });
  }

  private headers(
    credential: ChatGPTCredential,
    sessionId?: string,
    accept = "text/event-stream",
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: accept,
      "Content-Type": "application/json",
      originator: "eulr",
      version: this.protocolCompatibilityVersion,
      "x-client-request-id": randomUUID(),
      "thread-id": sessionId ?? randomUUID(),
    };
    if (sessionId !== undefined) {
      headers["session-id"] = sessionId;
    }
    if (credential.accountId !== undefined) {
      headers["ChatGPT-Account-ID"] = credential.accountId;
    }
    if (credential.isFedRamp === true) {
      headers["X-OpenAI-Fedramp"] = "true";
    }
    return headers;
  }

  private async retryDelay(
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const exponential = this.retryBaseDelayMs * 2 ** (attempt - 1);
    await this.sleep(exponential, signal);
  }

  private warn(message: string): void {
    this.onWarning?.(redactText(message));
  }
}

async function parseModelCatalogResponse(
  response: Response,
): Promise<z.infer<typeof modelsResponseSchema>> {
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw new ProviderError(
      `Codex model catalog response could not be read (HTTP ${response.status})`,
      { cause: error },
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body) as unknown;
  } catch (error) {
    throw new ProviderError(
      `Codex model catalog response was not valid JSON (HTTP ${response.status}): ${summarizeResponseText(body)}`,
      { cause: error },
    );
  }

  const parsed = modelsResponseSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ProviderError(
      `Codex model catalog response was invalid (HTTP ${response.status}); expected a top-level models array with valid catalog entries. Response: ${summarizeResponseText(body)}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function sanitizedResponseSummary(response: Response): Promise<string> {
  try {
    return summarizeResponseText(await response.text());
  } catch {
    return "response body unavailable";
  }
}

function summarizeResponseText(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact === "") return "empty response body";
  const truncated =
    compact.length > RESPONSE_SUMMARY_LIMIT
      ? `${compact.slice(0, RESPONSE_SUMMARY_LIMIT)}...`
      : compact;
  return redactText(truncated);
}

function normalizeCatalogVersion(
  version: string | [number, number, number],
): string {
  return Array.isArray(version) ? version.join(".") : version;
}

function compareSemanticVersions(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = semanticVersionParts(left);
  const [rightMajor, rightMinor, rightPatch] = semanticVersionParts(right);
  const differences = [
    leftMajor - rightMajor,
    leftMinor - rightMinor,
    leftPatch - rightPatch,
  ];
  for (const difference of differences) {
    if (difference !== 0) return difference;
  }
  return 0;
}

function semanticVersionParts(version: string): [number, number, number] {
  const match = SEMANTIC_VERSION_PATTERN.exec(version);
  if (match === null) {
    throw new ProviderError(`Invalid semantic version: ${redactText(version)}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function assertSemanticVersion(version: string, label: string): void {
  if (!SEMANTIC_VERSION_PATTERN.test(version)) {
    throw new ProviderError(`${label} is invalid: ${redactText(version)}`);
  }
}

function cloneModelList(models: readonly ModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    ...model,
    ...(model.supportedReasoningEfforts === undefined
      ? {}
      : {
          supportedReasoningEfforts: model.supportedReasoningEfforts.map(
            (option) => ({ ...option }),
          ),
        }),
  }));
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancellationError("Codex request cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancellationError("Codex request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
