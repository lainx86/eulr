import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialStore } from "../../src/auth/credential-store.js";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("CredentialStore", () => {
  it("stores credentials atomically with user-only POSIX permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eulr-auth-"));
    directories.push(root);
    const filePath = path.join(root, "nested", "auth.json");
    const store = new CredentialStore({ path: filePath });

    await store.saveChatGPT({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "id-secret",
      expiresAt: 123_000,
      accountId: "account-1",
    });
    await store.saveApiKey({
      apiKey: "sk-test-secret",
      baseUrl: "https://api.test/v1",
    });

    expect(await store.getChatGPT()).toMatchObject({
      accessToken: "access-secret",
      accountId: "account-1",
    });
    expect(await store.getApiKey()).toEqual({
      apiKey: "sk-test-secret",
      baseUrl: "https://api.test/v1",
    });
    expect(await store.listProviderIds()).toEqual([
      "openai-codex",
      "openai-compatible",
    ]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 1,
    });

    if (process.platform !== "win32") {
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
    const temporaryFiles = (await import("node:fs/promises")).readdir(
      path.dirname(filePath),
    );
    expect(
      (await temporaryFiles).filter((name) => name.includes(".tmp")),
    ).toEqual([]);
  });

  it("deletes only the selected provider credential", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eulr-auth-"));
    directories.push(root);
    const store = new CredentialStore({ path: path.join(root, "auth.json") });
    await store.saveChatGPT({ accessToken: "a", expiresAt: 1 });
    await store.saveApiKey({ apiKey: "b" });

    await expect(store.delete("openai-codex")).resolves.toBe(true);
    await expect(store.getChatGPT()).resolves.toBeUndefined();
    await expect(store.getApiKey()).resolves.toEqual({ apiKey: "b" });
    await expect(store.delete("missing")).resolves.toBe(false);
  });

  it("does not lose concurrent updates from separate store instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eulr-auth-"));
    directories.push(root);
    const filePath = path.join(root, "auth.json");
    const first = new CredentialStore({ path: filePath });
    const second = new CredentialStore({ path: filePath });

    await Promise.all([
      first.saveChatGPT({ accessToken: "access", expiresAt: 1 }),
      second.saveApiKey({ apiKey: "api-key" }),
    ]);

    await expect(first.listProviderIds()).resolves.toEqual([
      "openai-codex",
      "openai-compatible",
    ]);
  });
});
