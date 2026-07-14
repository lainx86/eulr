import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  IncomingMessage,
  RequestListener,
  Server,
  ServerResponse,
} from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_SCOPE,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generatePkce,
  loginWithBrowser,
  startLoopbackCallbackServer,
} from "../../src/auth/chatgpt-oauth.js";
import { CancellationError } from "../../src/utils/errors.js";
import { fakeFetch, jsonResponse, makeJwt } from "./helpers.js";

function fakeLoopbackServer(): {
  factory: (listener: RequestListener) => Server;
  navigate(url: URL): Promise<number>;
} {
  let listener: RequestListener | undefined;
  class FakeServer extends EventEmitter {
    listening = false;

    listen(): this {
      this.listening = true;
      queueMicrotask(() => this.emit("listening"));
      return this;
    }

    address(): { address: string; family: string; port: number } {
      return { address: "127.0.0.1", family: "IPv4", port: 32145 };
    }

    close(callback?: (error?: Error) => void): this {
      this.listening = false;
      queueMicrotask(() => callback?.());
      return this;
    }
  }
  return {
    factory: (requestListener) => {
      listener = requestListener;
      return new FakeServer() as unknown as Server;
    },
    navigate: async (url) => {
      if (listener === undefined) {
        throw new Error("Fake callback server is not listening");
      }
      const activeListener = listener;
      return new Promise<number>((resolve) => {
        let statusCode = 200;
        const response = {
          setHeader: () => undefined,
          writeHead: (status: number) => {
            statusCode = status;
            return response;
          },
          end: () => resolve(statusCode),
        } as unknown as ServerResponse;
        activeListener(
          { url: `${url.pathname}${url.search}` } as IncomingMessage,
          response,
        );
      });
    },
  };
}

describe("ChatGPT browser OAuth", () => {
  it("generates a cryptographically sized S256 PKCE pair", () => {
    const pair = generatePkce();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(pair.challenge).toBe(
      createHash("sha256").update(pair.verifier).digest("base64url"),
    );
  });

  it("builds the current Codex authorization request without impersonating Codex CLI", () => {
    const url = new URL(
      buildAuthorizationUrl({
        redirectUri: "http://localhost:1455/auth/callback",
        state: "state",
        challenge: "challenge",
      }),
    );
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CHATGPT_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe(CHATGPT_OAUTH_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("originator")).toBe("eulr");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
  });

  it("receives a code on a loopback-only callback and validates state", async () => {
    const loopback = fakeLoopbackServer();
    const callback = await startLoopbackCallbackServer({
      state: "expected-state",
      ports: [0],
      timeoutMs: 1_000,
      serverFactory: loopback.factory,
    });
    try {
      const waiting = callback.waitForCode();
      const url = new URL(callback.redirectUri);
      url.searchParams.set("code", "authorization-code");
      url.searchParams.set("state", "expected-state");
      expect(await loopback.navigate(url)).toBe(200);
      await expect(waiting).resolves.toBe("authorization-code");
      expect(new URL(callback.redirectUri).hostname).toBe("localhost");
    } finally {
      await callback.close();
    }
  });

  it("binds only to IPv4 loopback and falls back from port 1455 to 1457", async () => {
    const attempts: Array<{ host?: string; port?: number }> = [];
    class FallbackServer extends EventEmitter {
      listening = false;

      listen(options: { host?: string; port?: number }): this {
        attempts.push(options);
        if (attempts.length === 1) {
          queueMicrotask(() => {
            const error = Object.assign(new Error("in use"), {
              code: "EADDRINUSE",
            });
            this.emit("error", error);
          });
        } else {
          this.listening = true;
          queueMicrotask(() => this.emit("listening"));
        }
        return this;
      }

      address(): { address: string; family: string; port: number } {
        return { address: "127.0.0.1", family: "IPv4", port: 1457 };
      }

      close(callback?: () => void): this {
        this.listening = false;
        queueMicrotask(() => callback?.());
        return this;
      }
    }
    const controller = new AbortController();
    const callback = await startLoopbackCallbackServer({
      state: "state",
      timeoutMs: 1_000,
      signal: controller.signal,
      serverFactory: () => new FallbackServer() as unknown as Server,
    });
    expect(attempts).toEqual([
      { host: "127.0.0.1", port: 1455 },
      { host: "127.0.0.1", port: 1457 },
    ]);
    expect(callback.redirectUri).toBe("http://localhost:1457/auth/callback");
    const waiting = callback.waitForCode();
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(CancellationError);
    await callback.close();
  });

  it("rejects a wrong state without preventing a later valid callback", async () => {
    const loopback = fakeLoopbackServer();
    const callback = await startLoopbackCallbackServer({
      state: "expected-state",
      ports: [0],
      timeoutMs: 1_000,
      serverFactory: loopback.factory,
    });
    try {
      const waiting = callback.waitForCode();
      const url = new URL(callback.redirectUri);
      url.searchParams.set("code", "do-not-use");
      url.searchParams.set("state", "wrong-state");
      expect(await loopback.navigate(url)).toBe(400);

      url.searchParams.set("code", "authorization-code");
      url.searchParams.set("state", "expected-state");
      expect(await loopback.navigate(url)).toBe(200);
      await expect(waiting).resolves.toBe("authorization-code");
    } finally {
      await callback.close();
    }
  });

  it("supports callback cancellation and timeout", async () => {
    const controller = new AbortController();
    const cancelledLoopback = fakeLoopbackServer();
    const cancelled = await startLoopbackCallbackServer({
      state: "state",
      ports: [0],
      signal: controller.signal,
      timeoutMs: 1_000,
      serverFactory: cancelledLoopback.factory,
    });
    const cancelledResult = cancelled.waitForCode();
    controller.abort();
    await expect(cancelledResult).rejects.toBeInstanceOf(CancellationError);
    await cancelled.close();

    const timeoutLoopback = fakeLoopbackServer();
    const timedOut = await startLoopbackCallbackServer({
      state: "state",
      ports: [0],
      timeoutMs: 5,
      serverFactory: timeoutLoopback.factory,
    });
    await expect(timedOut.waitForCode()).rejects.toThrow("timed out");
    await timedOut.close();

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(
      loginWithBrowser({ signal: alreadyCancelled.signal }),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it("exchanges the code with form encoding and rejects token failures", async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code_verifier")).toBe("verifier");
        return jsonResponse({ error: "invalid_grant" }, 400);
      },
    );
    await expect(
      exchangeAuthorizationCode({
        code: "code",
        verifier: "verifier",
        redirectUri: "http://localhost/callback",
        fetch: fakeFetch(request),
      }),
    ).rejects.toThrow("HTTP 400");
  });

  it("completes browser login when browser opening fails and exposes the URL", async () => {
    const now = 10_000;
    const accessToken = makeJwt({ exp: 500 });
    const idToken = makeJwt({
      email: "person@example.test",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "pro",
      },
    });
    const tokenRequest = vi.fn(async () =>
      jsonResponse({
        access_token: accessToken,
        refresh_token: "refresh-secret",
        id_token: idToken,
      }),
    );
    const loopback = fakeLoopbackServer();
    const credential = await loginWithBrowser({
      ports: [0],
      now: () => now,
      fetch: fakeFetch(tokenRequest),
      serverFactory: loopback.factory,
      openBrowser: async () => false,
      onAuthorizationUrl: async (authorizationUrl, opened) => {
        expect(opened).toBe(false);
        const authorization = new URL(authorizationUrl);
        const callbackUrl = new URL(
          authorization.searchParams.get("redirect_uri") ?? "",
        );
        callbackUrl.searchParams.set("code", "real-code");
        callbackUrl.searchParams.set(
          "state",
          authorization.searchParams.get("state") ?? "",
        );
        expect(await loopback.navigate(callbackUrl)).toBe(200);
      },
    });

    expect(credential).toMatchObject({
      accessToken,
      refreshToken: "refresh-secret",
      expiresAt: 500_000,
      accountId: "account-1",
      email: "person@example.test",
      planType: "pro",
    });
    expect(tokenRequest).toHaveBeenCalledOnce();
  });
});
