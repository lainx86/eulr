import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../../src/auth/auth-service.js";
import { CredentialStore } from "../../src/auth/credential-store.js";
import { CancellationError } from "../../src/utils/errors.js";
import { fakeFetch, jsonResponse, makeJwt } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function createStore(): Promise<CredentialStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "eulr-auth-service-"));
  directories.push(directory);
  return new CredentialStore({ path: path.join(directory, "auth.json") });
}

describe("AuthService", () => {
  it("refreshes an expiring token once for concurrent callers", async () => {
    const store = await createStore();
    const now = 1_000_000;
    const oldAccessToken = makeJwt({ exp: now / 1000 + 60 });
    await store.saveChatGPT({
      accessToken: oldAccessToken,
      refreshToken: "old-refresh",
      idToken: makeJwt({
        email: "person@example.test",
        "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
      }),
      expiresAt: now + 60_000,
      lastRefreshAt: now - 100,
    });
    const refresh = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: "client",
          grant_type: "refresh_token",
          refresh_token: "old-refresh",
        });
        await Promise.resolve();
        return jsonResponse({
          access_token: makeJwt({ exp: now / 1000 + 3600 }),
          refresh_token: "new-refresh",
        });
      },
    );
    const auth = new AuthService(store, {
      now: () => now,
      clientId: "client",
      endpoints: { token: "https://auth.test/token" },
      fetch: fakeFetch(refresh),
    });

    const [first, second, third] = await Promise.all([
      auth.getValidChatGPTCredential(),
      auth.getValidChatGPTCredential(),
      auth.getValidChatGPTCredential(),
    ]);

    expect(refresh).toHaveBeenCalledOnce();
    expect(first.accessToken).toBe(second.accessToken);
    expect(second.accessToken).toBe(third.accessToken);
    expect(first.refreshToken).toBe("new-refresh");
    expect(first.accountId).toBe("account-1");
    expect((await store.getChatGPT())?.refreshToken).toBe("new-refresh");

    const afterStaleUnauthorized = await auth.forceRefreshChatGPT(
      undefined,
      oldAccessToken,
    );
    expect(afterStaleUnauthorized.accessToken).toBe(first.accessToken);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("lets one caller cancel without aborting the shared refresh", async () => {
    const store = await createStore();
    const now = 1_000_000;
    await store.saveChatGPT({
      accessToken: makeJwt({ exp: now / 1000 + 60 }),
      refreshToken: "old-refresh",
      expiresAt: now + 60_000,
    });
    let completeRefresh!: (response: Response) => void;
    const request = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          completeRefresh = resolve;
        }),
    );
    const auth = new AuthService(store, {
      now: () => now,
      fetch: fakeFetch(request),
    });
    const firstController = new AbortController();
    const first = auth.getValidChatGPTCredential(firstController.signal);
    const second = auth.getValidChatGPTCredential();
    const firstOutcome = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    firstController.abort();
    expect(await firstOutcome).toBeInstanceOf(CancellationError);
    completeRefresh(
      jsonResponse({ access_token: makeJwt({ exp: now / 1000 + 3600 }) }),
    );

    await expect(second).resolves.toMatchObject({
      refreshToken: "old-refresh",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("aborts the refresh transport after its only caller cancels", async () => {
    const store = await createStore();
    const now = 1_000_000;
    await store.saveChatGPT({
      accessToken: makeJwt({ exp: now / 1000 + 60 }),
      refreshToken: "old-refresh",
      expiresAt: now + 60_000,
    });
    let transportSignal: AbortSignal | undefined;
    const request = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        transportSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const auth = new AuthService(store, {
      now: () => now,
      fetch: fakeFetch(request),
    });
    const controller = new AbortController();
    const refreshing = auth
      .getValidChatGPTCredential(controller.signal)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    controller.abort();

    expect(await refreshing).toBeInstanceOf(CancellationError);
    await vi.waitFor(() => expect(transportSignal?.aborted).toBe(true));
  });

  it("serializes refresh across service instances sharing one store", async () => {
    const firstStore = await createStore();
    const secondStore = new CredentialStore({ path: firstStore.path });
    const now = 1_000_000;
    await firstStore.saveChatGPT({
      accessToken: makeJwt({ exp: now / 1000 + 60 }),
      refreshToken: "old-refresh",
      expiresAt: now + 60_000,
    });
    const request = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({
        access_token: makeJwt({ exp: now / 1000 + 3600 }),
        refresh_token: "new-refresh",
      });
    });
    const options = { now: () => now, fetch: fakeFetch(request) };
    const first = new AuthService(firstStore, options);
    const second = new AuthService(secondStore, options);

    const [firstCredential, secondCredential] = await Promise.all([
      first.getValidChatGPTCredential(),
      second.getValidChatGPTCredential(),
    ]);

    expect(request).toHaveBeenCalledOnce();
    expect(firstCredential.accessToken).toBe(secondCredential.accessToken);
    expect(secondCredential.refreshToken).toBe("new-refresh");
  });

  it("classifies invalid refresh credentials as requiring login", async () => {
    const store = await createStore();
    await store.saveChatGPT({
      accessToken: makeJwt({ exp: 1 }),
      refreshToken: "bad-refresh",
      expiresAt: 1_000,
    });
    const auth = new AuthService(store, {
      now: () => 10_000,
      fetch: fakeFetch(async () =>
        jsonResponse({ error: { code: "refresh_token_reused" } }, 400),
      ),
    });

    await expect(auth.getValidChatGPTCredential()).rejects.toThrow(
      "Run: eulr auth login",
    );
  });

  it("returns sanitized status and logs out only eulr credentials", async () => {
    const store = await createStore();
    const auth = new AuthService(store);
    await store.saveChatGPT({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 123,
      accountId: "account-1",
      email: "person@example.test",
    });

    const status = await auth.status("openai-codex");
    expect(status).toEqual([
      {
        providerId: "openai-codex",
        authenticated: true,
        method: "chatgpt",
        expiresAt: 123,
        accountId: "account-1",
        email: "person@example.test",
      },
    ]);
    expect(JSON.stringify(status)).not.toContain("secret");
    await expect(auth.logout("openai-codex")).resolves.toBe(true);
    await expect(auth.status("openai-codex")).resolves.toEqual([
      { providerId: "openai-codex", authenticated: false },
    ]);
  });

  it("does not restore a credential when logout races with refresh", async () => {
    const store = await createStore();
    await store.saveChatGPT({
      accessToken: makeJwt({ exp: 1000 }),
      refreshToken: "refresh",
      expiresAt: 1_000_000,
    });
    let resolveRefresh!: (response: Response) => void;
    const request = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const auth = new AuthService(store, { fetch: fakeFetch(request) });
    const refreshing = auth.forceRefreshChatGPT();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    await auth.logout("openai-codex");
    resolveRefresh(jsonResponse({ access_token: makeJwt({ exp: 2000 }) }));

    await expect(refreshing).rejects.toThrow("changed while a refresh");
    await expect(store.getChatGPT()).resolves.toBeUndefined();
  });

  it("lists only usable or refreshable provider credentials", async () => {
    const store = await createStore();
    const auth = new AuthService(store, { now: () => 10_000 });
    await store.saveChatGPT({
      accessToken: makeJwt({ exp: 1 }),
      expiresAt: 1_000,
    });
    await store.saveApiKey({ apiKey: "key" });
    await expect(auth.readyProviderIds()).resolves.toEqual([
      "openai-compatible",
    ]);

    await store.saveChatGPT({
      accessToken: makeJwt({ exp: 1 }),
      refreshToken: "refresh",
      expiresAt: 1_000,
    });
    await expect(auth.readyProviderIds()).resolves.toEqual([
      "openai-codex",
      "openai-compatible",
    ]);
  });

  it("stores and retrieves compatible API credentials", async () => {
    const store = await createStore();
    const auth = new AuthService(store);
    await auth.saveApiCredential({
      apiKey: "sk-private",
      baseUrl: "https://compatible.test/v1",
    });
    await expect(auth.getApiCredential()).resolves.toEqual({
      apiKey: "sk-private",
      baseUrl: "https://compatible.test/v1",
    });
  });
});
