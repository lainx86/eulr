import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";

import { z } from "zod";

import {
  AuthenticationError,
  CancellationError,
  errorMessage,
} from "../utils/errors.js";
import { openBrowser } from "./browser.js";
import type { BrowserOpener } from "./browser.js";
import type { ChatGPTCredential, FetchImplementation } from "./types.js";

export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_OAUTH_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CHATGPT_CALLBACK_PORTS = [1455, 1457] as const;
export const DEFAULT_BROWSER_TIMEOUT_MS = 10 * 60 * 1000;
const FALLBACK_REFRESH_DEADLINE_MS = 8 * 24 * 60 * 60 * 1000;

export interface OAuthEndpoints {
  authorization: string;
  token: string;
}

export const DEFAULT_OAUTH_ENDPOINTS: OAuthEndpoints = {
  authorization: `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`,
  token: `${CHATGPT_OAUTH_ISSUER}/oauth/token`,
};

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
}

const authorizationTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface AuthorizationUrlOptions {
  redirectUri: string;
  state: string;
  challenge: string;
  clientId?: string;
  endpoint?: string;
  originator?: string;
  allowedWorkspaceIds?: string[];
}

export function buildAuthorizationUrl(
  options: AuthorizationUrlOptions,
): string {
  const url = new URL(
    options.endpoint ?? DEFAULT_OAUTH_ENDPOINTS.authorization,
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "client_id",
    options.clientId ?? CHATGPT_OAUTH_CLIENT_ID,
  );
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", options.state);
  url.searchParams.set("originator", options.originator ?? "eulr");
  if (options.allowedWorkspaceIds?.length) {
    url.searchParams.set(
      "allowed_workspace_id",
      options.allowedWorkspaceIds.join(","),
    );
  }
  return url.toString();
}

export interface CallbackServer {
  redirectUri: string;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export interface CallbackServerOptions {
  state: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  ports?: readonly number[];
  serverFactory?: (listener: RequestListener) => Server;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export async function startLoopbackCallbackServer(
  options: CallbackServerOptions,
): Promise<CallbackServer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
  const create = options.serverFactory ?? createServer;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort = (): void => undefined;

  const completion = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const finish = (result: { code: string } | { error: Error }): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer !== undefined) {
      (options.clearTimer ?? clearTimeout)(timer);
    }
    options.signal?.removeEventListener("abort", onAbort);
    if ("code" in result) {
      resolveCode(result.code);
    } else {
      rejectCode(result.error);
    }
  };

  const listener: RequestListener = (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const returnedState = url.searchParams.get("state");
    if (returnedState !== options.state) {
      response.writeHead(400);
      response.end(
        "<!doctype html><title>eulr login failed</title><p>OAuth state mismatch. Return to the terminal.</p>",
      );
      return;
    }

    const oauthError = url.searchParams.get("error");
    if (oauthError !== null) {
      response.writeHead(400);
      response.end(
        "<!doctype html><title>eulr login failed</title><p>Authorization was not completed. Return to the terminal.</p>",
      );
      finish({
        error: new AuthenticationError(
          `ChatGPT authorization failed: ${oauthError}`,
        ),
      });
      return;
    }

    const code = url.searchParams.get("code");
    if (code === null || code.length === 0) {
      response.writeHead(400);
      response.end(
        "<!doctype html><title>eulr login failed</title><p>Missing authorization code. Return to the terminal.</p>",
      );
      finish({
        error: new AuthenticationError("OAuth callback omitted the code"),
      });
      return;
    }

    response.writeHead(200);
    response.end(
      "<!doctype html><title>eulr login complete</title><p>Login complete. You can close this window.</p>",
    );
    finish({ code });
  };

  const server = create(listener);
  let selectedPort: number | undefined;
  for (const port of options.ports ?? CHATGPT_CALLBACK_PORTS) {
    try {
      await listen(server, port);
      const address = server.address();
      selectedPort =
        typeof address === "object" && address !== null ? address.port : port;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw new AuthenticationError("Unable to start OAuth callback server", {
          cause: error,
        });
      }
    }
  }
  if (selectedPort === undefined) {
    throw new AuthenticationError(
      `OAuth callback ports are already in use: ${(options.ports ?? CHATGPT_CALLBACK_PORTS).join(", ")}`,
    );
  }

  onAbort = (): void => {
    finish({ error: new CancellationError("ChatGPT login cancelled") });
  };
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }
  if (!settled) {
    timer = (options.setTimer ?? setTimeout)(() => {
      finish({ error: new AuthenticationError("ChatGPT login timed out") });
    }, timeoutMs);
  }

  return {
    redirectUri: `http://localhost:${selectedPort}/auth/callback`,
    waitForCode: () => completion,
    close: () => closeServer(server),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export interface ExchangeAuthorizationCodeOptions {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId?: string;
  tokenEndpoint?: string;
  fetch?: FetchImplementation;
  signal?: AbortSignal;
}

export async function exchangeAuthorizationCode(
  options: ExchangeAuthorizationCodeOptions,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      options.tokenEndpoint ?? DEFAULT_OAUTH_ENDPOINTS.token,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: options.code,
          redirect_uri: options.redirectUri,
          client_id: options.clientId ?? CHATGPT_OAUTH_CLIENT_ID,
          code_verifier: options.verifier,
        }),
        signal: options.signal,
      },
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw new CancellationError("ChatGPT login cancelled", { cause: error });
    }
    throw new AuthenticationError(
      "Unable to exchange ChatGPT authorization code",
      {
        cause: error,
      },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthenticationError(
      `ChatGPT token exchange failed with HTTP ${response.status}`,
    );
  }
  try {
    const value = authorizationTokenSchema.parse(await response.json());
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      idToken: value.id_token,
      expiresIn: value.expires_in,
    };
  } catch (error) {
    throw new AuthenticationError("ChatGPT token response was invalid", {
      cause: error,
    });
  }
}

export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function credentialFromTokenResponse(
  response: TokenResponse,
  now = Date.now(),
): ChatGPTCredential {
  const accessClaims = decodeJwtPayload(response.accessToken);
  const idClaims = response.idToken
    ? decodeJwtPayload(response.idToken)
    : undefined;
  const authClaims = idClaims?.["https://api.openai.com/auth"];
  const profileClaims = idClaims?.["https://api.openai.com/profile"];
  const auth =
    typeof authClaims === "object" && authClaims !== null
      ? (authClaims as Record<string, unknown>)
      : undefined;
  const profile =
    typeof profileClaims === "object" && profileClaims !== null
      ? (profileClaims as Record<string, unknown>)
      : undefined;
  const expirationSeconds =
    typeof accessClaims?.exp === "number" ? accessClaims.exp : undefined;
  const expiresAt =
    expirationSeconds !== undefined
      ? expirationSeconds * 1000
      : response.expiresIn !== undefined
        ? now + response.expiresIn * 1000
        : now + FALLBACK_REFRESH_DEADLINE_MS;

  return {
    accessToken: response.accessToken,
    ...(response.refreshToken ? { refreshToken: response.refreshToken } : {}),
    ...(response.idToken ? { idToken: response.idToken } : {}),
    expiresAt,
    accountId: stringClaim(auth, "chatgpt_account_id"),
    email: stringClaim(idClaims, "email") ?? stringClaim(profile, "email"),
    planType: stringClaim(auth, "chatgpt_plan_type"),
    isFedRamp:
      typeof auth?.chatgpt_account_is_fedramp === "boolean"
        ? auth.chatgpt_account_is_fedramp
        : undefined,
    lastRefreshAt: now,
  };
}

function stringClaim(
  claims: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = claims?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface BrowserLoginOptions {
  fetch?: FetchImplementation;
  openBrowser?: BrowserOpener;
  onAuthorizationUrl?: (
    url: string,
    browserOpened: boolean,
  ) => void | Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  ports?: readonly number[];
  serverFactory?: (listener: RequestListener) => Server;
  now?: () => number;
  clientId?: string;
  endpoints?: Partial<OAuthEndpoints>;
  originator?: string;
  allowedWorkspaceIds?: string[];
}

export async function loginWithBrowser(
  options: BrowserLoginOptions = {},
): Promise<ChatGPTCredential> {
  if (options.signal?.aborted) {
    throw new CancellationError("ChatGPT login cancelled", {
      cause: options.signal.reason,
    });
  }
  const state = generateOAuthState();
  const pkce = generatePkce();
  const callback = await startLoopbackCallbackServer({
    state,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    ports: options.ports,
    serverFactory: options.serverFactory,
  });

  try {
    if (options.signal?.aborted) {
      await callback.waitForCode();
    }
    const authorizationUrl = buildAuthorizationUrl({
      redirectUri: callback.redirectUri,
      state,
      challenge: pkce.challenge,
      clientId: options.clientId,
      endpoint: options.endpoints?.authorization,
      originator: options.originator,
      allowedWorkspaceIds: options.allowedWorkspaceIds,
    });
    const browserOpened = await (options.openBrowser ?? openBrowser)(
      authorizationUrl,
    );
    await options.onAuthorizationUrl?.(authorizationUrl, browserOpened);
    const code = await callback.waitForCode();
    const tokens = await exchangeAuthorizationCode({
      code,
      verifier: pkce.verifier,
      redirectUri: callback.redirectUri,
      clientId: options.clientId,
      tokenEndpoint: options.endpoints?.token,
      fetch: options.fetch,
      signal: options.signal,
    });
    return credentialFromTokenResponse(tokens, (options.now ?? Date.now)());
  } catch (error) {
    if (
      error instanceof AuthenticationError ||
      error instanceof CancellationError
    ) {
      throw error;
    }
    throw new AuthenticationError(
      `ChatGPT login failed: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  } finally {
    await callback.close();
  }
}
