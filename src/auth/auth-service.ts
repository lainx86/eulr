import { z } from "zod";

import { AuthenticationError, CancellationError } from "../utils/errors.js";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_ENDPOINTS,
  credentialFromTokenResponse,
  decodeJwtPayload,
  loginWithBrowser,
} from "./chatgpt-oauth.js";
import type {
  BrowserLoginOptions,
  OAuthEndpoints,
  TokenResponse,
} from "./chatgpt-oauth.js";
import { CredentialStore } from "./credential-store.js";
import { loginWithDeviceCode } from "./device-auth.js";
import type { DeviceLoginOptions } from "./device-auth.js";
import type {
  ApiCredential,
  AuthenticationStatus,
  ChatGPTCredential,
  FetchImplementation,
} from "./types.js";

const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const FALLBACK_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;
const PERMANENT_REFRESH_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

const refreshResponseSchema = z.object({
  id_token: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
});

export interface AuthServiceOptions {
  fetch?: FetchImplementation;
  now?: () => number;
  clientId?: string;
  endpoints?: Partial<OAuthEndpoints>;
}

export class AuthService {
  readonly store: CredentialStore;
  private readonly request: FetchImplementation;
  private readonly now: () => number;
  private readonly clientId: string;
  private readonly endpoints: OAuthEndpoints;
  private refreshPromise?: Promise<ChatGPTCredential>;
  private refreshController?: AbortController;
  private refreshWaiters = 0;
  private chatGPTGeneration = 0;

  constructor(store = new CredentialStore(), options: AuthServiceOptions = {}) {
    this.store = store;
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.clientId = options.clientId ?? CHATGPT_OAUTH_CLIENT_ID;
    this.endpoints = {
      authorization:
        options.endpoints?.authorization ??
        DEFAULT_OAUTH_ENDPOINTS.authorization,
      token: options.endpoints?.token ?? DEFAULT_OAUTH_ENDPOINTS.token,
    };
  }

  async loginChatGPTBrowser(
    options: Omit<
      BrowserLoginOptions,
      "fetch" | "now" | "clientId" | "endpoints"
    > = {},
  ): Promise<ChatGPTCredential> {
    const credential = await loginWithBrowser({
      ...options,
      fetch: this.request,
      now: this.now,
      clientId: this.clientId,
      endpoints: this.endpoints,
      originator: options.originator ?? "eulr",
    });
    await this.store.saveChatGPT(credential);
    this.chatGPTGeneration += 1;
    return credential;
  }

  async loginChatGPTDevice(
    options: Omit<DeviceLoginOptions, "fetch" | "now" | "clientId"> = {},
  ): Promise<ChatGPTCredential> {
    const credential = await loginWithDeviceCode({
      ...options,
      fetch: this.request,
      now: this.now,
      clientId: this.clientId,
      endpoints: {
        ...options.endpoints,
        token: options.endpoints?.token ?? this.endpoints.token,
      },
    });
    await this.store.saveChatGPT(credential);
    this.chatGPTGeneration += 1;
    return credential;
  }

  async saveApiCredential(
    credential: ApiCredential,
    providerId = "openai-compatible",
  ): Promise<void> {
    await this.store.saveApiKey(credential, providerId);
  }

  async getApiCredential(
    providerId = "openai-compatible",
  ): Promise<ApiCredential> {
    const credential = await this.store.getApiKey(providerId);
    if (credential === undefined) {
      throw new AuthenticationError(
        `No API credential for ${providerId}. Run: eulr auth login`,
      );
    }
    return credential;
  }

  async getValidChatGPTCredential(
    signal?: AbortSignal,
  ): Promise<ChatGPTCredential> {
    const credential = await this.requireChatGPTCredential();
    if (this.shouldRefresh(credential)) {
      return this.refresh(false, signal);
    }
    return credential;
  }

  async forceRefreshChatGPT(
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<ChatGPTCredential> {
    return this.refresh(true, signal, rejectedAccessToken);
  }

  async status(providerId?: string): Promise<AuthenticationStatus[]> {
    const providerIds =
      providerId === undefined
        ? await this.store.listProviderIds()
        : [providerId];
    if (providerIds.length === 0 && providerId !== undefined) {
      return [{ providerId, authenticated: false }];
    }
    return Promise.all(
      providerIds.map(async (id): Promise<AuthenticationStatus> => {
        const credential = await this.store.get(id);
        if (credential === undefined) {
          return { providerId: id, authenticated: false };
        }
        if (credential.type === "api-key") {
          return {
            providerId: id,
            authenticated: true,
            method: "api-key",
            ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
          };
        }
        return {
          providerId: id,
          authenticated: true,
          method: "chatgpt",
          expiresAt: credential.expiresAt,
          ...(credential.accountId ? { accountId: credential.accountId } : {}),
          ...(credential.email ? { email: credential.email } : {}),
          ...(credential.planType ? { planType: credential.planType } : {}),
        };
      }),
    );
  }

  async readyProviderIds(): Promise<string[]> {
    const ready: string[] = [];
    for (const providerId of await this.store.listProviderIds()) {
      const credential = await this.store.get(providerId);
      if (credential?.type === "api-key") {
        ready.push(providerId);
        continue;
      }
      if (credential?.type === "chatgpt") {
        const claims = decodeJwtPayload(credential.accessToken);
        const expiresAt =
          typeof claims?.exp === "number"
            ? claims.exp * 1000
            : credential.expiresAt;
        if (expiresAt > this.now() || credential.refreshToken !== undefined) {
          ready.push(providerId);
        }
      }
    }
    return ready;
  }

  async logout(providerId: string): Promise<boolean> {
    if (providerId === "openai-codex") {
      this.chatGPTGeneration += 1;
    }
    return this.store.delete(providerId);
  }

  private async refresh(
    force: boolean,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<ChatGPTCredential> {
    if (signal?.aborted) {
      throw new CancellationError("ChatGPT token refresh cancelled", {
        cause: signal.reason,
      });
    }
    if (this.refreshPromise !== undefined) {
      return this.waitForRefresh(this.refreshPromise, signal);
    }
    const controller = new AbortController();
    this.refreshController = controller;
    const operation = this.store
      .withRefreshLock(
        () => this.refreshOnce(force, rejectedAccessToken, controller.signal),
        controller.signal,
      )
      .finally(() => {
        if (this.refreshPromise === operation) {
          this.refreshPromise = undefined;
          this.refreshController = undefined;
        }
      });
    this.refreshPromise = operation;
    return this.waitForRefresh(operation, signal);
  }

  private async refreshOnce(
    force: boolean,
    rejectedAccessToken?: string,
    signal?: AbortSignal,
  ): Promise<ChatGPTCredential> {
    const generation = this.chatGPTGeneration;
    const current = await this.requireChatGPTCredential();
    if (
      rejectedAccessToken !== undefined &&
      current.accessToken !== rejectedAccessToken
    ) {
      return current;
    }
    if (!force && !this.shouldRefresh(current)) {
      return current;
    }
    if (current.refreshToken === undefined) {
      throw new AuthenticationError(
        "ChatGPT credential cannot be refreshed. Run: eulr auth login",
      );
    }

    let response: Response;
    try {
      response = await this.request(this.endpoints.token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.clientId,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CancellationError("ChatGPT token refresh cancelled", {
          cause: error,
        });
      }
      throw new AuthenticationError("Unable to refresh ChatGPT credential", {
        cause: error,
      });
    }

    if (!response.ok) {
      const code = await readOAuthErrorCode(response);
      if (
        response.status === 401 ||
        (code !== undefined && PERMANENT_REFRESH_CODES.has(code))
      ) {
        throw new AuthenticationError(
          "ChatGPT session is no longer valid. Run: eulr auth login",
        );
      }
      throw new AuthenticationError(
        `ChatGPT token refresh failed with HTTP ${response.status}. Try again.`,
      );
    }

    let update;
    try {
      update = refreshResponseSchema.parse(await response.json());
    } catch (error) {
      throw new AuthenticationError("ChatGPT refresh response was invalid", {
        cause: error,
      });
    }
    const tokens: TokenResponse = {
      accessToken: update.access_token ?? current.accessToken,
      refreshToken: update.refresh_token ?? current.refreshToken,
      idToken: update.id_token ?? current.idToken,
    };
    const refreshed = credentialFromTokenResponse(tokens, this.now());
    refreshed.workspaceId = current.workspaceId;
    const latest = await this.store.getChatGPT();
    if (
      generation !== this.chatGPTGeneration ||
      latest === undefined ||
      latest.accessToken !== current.accessToken ||
      latest.refreshToken !== current.refreshToken
    ) {
      throw new AuthenticationError(
        "ChatGPT credential changed while a refresh was in progress",
      );
    }
    await this.store.saveChatGPT(refreshed);
    return refreshed;
  }

  private async waitForRefresh(
    operation: Promise<ChatGPTCredential>,
    signal?: AbortSignal,
  ): Promise<ChatGPTCredential> {
    this.refreshWaiters += 1;
    try {
      return await waitForCaller(operation, signal);
    } finally {
      this.refreshWaiters -= 1;
      if (
        this.refreshWaiters === 0 &&
        this.refreshPromise === operation &&
        this.refreshController?.signal.aborted === false
      ) {
        this.refreshController.abort(
          new CancellationError("All token refresh callers cancelled"),
        );
      }
    }
  }

  private async requireChatGPTCredential(): Promise<ChatGPTCredential> {
    const credential = await this.store.getChatGPT();
    if (credential === undefined) {
      throw new AuthenticationError(
        "No ChatGPT credential. Run: eulr auth login",
      );
    }
    return credential;
  }

  private shouldRefresh(credential: ChatGPTCredential): boolean {
    const claims = decodeJwtPayload(credential.accessToken);
    if (typeof claims?.exp === "number") {
      return claims.exp * 1000 <= this.now() + REFRESH_WINDOW_MS;
    }
    if (credential.lastRefreshAt !== undefined) {
      return (
        credential.lastRefreshAt <= this.now() - FALLBACK_REFRESH_INTERVAL_MS
      );
    }
    return credential.expiresAt <= this.now() + REFRESH_WINDOW_MS;
  }
}

function waitForCaller<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    return Promise.reject(
      new CancellationError("ChatGPT token refresh cancelled", {
        cause: signal.reason,
      }),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(
        new CancellationError("ChatGPT token refresh cancelled", {
          cause: signal.reason,
        }),
      );
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function readOAuthErrorCode(
  response: Response,
): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.code === "string") {
    return record.code.toLowerCase();
  }
  if (typeof record.error === "string") {
    return record.error.toLowerCase();
  }
  if (typeof record.error === "object" && record.error !== null) {
    const code = (record.error as Record<string, unknown>).code;
    return typeof code === "string" ? code.toLowerCase() : undefined;
  }
  return undefined;
}

export { PERMANENT_REFRESH_CODES, REFRESH_WINDOW_MS };
