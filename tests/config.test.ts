import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigStore,
  selectBaseUrl,
  selectModel,
  selectProvider,
} from "../src/config/config-store.js";
import { ConfigurationError } from "../src/utils/errors.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("configuration", () => {
  it("loads defaults and atomically persists provider settings with private mode", async () => {
    const root = await temporaryRoot();
    const path = join(root, "nested", "config.json");
    const store = new ConfigStore(path);

    expect(await store.load()).toEqual({ providers: {} });
    await store.setDefaultProvider("openai-compatible");
    await store.setDefaultModel("openai-compatible", "test-model");

    expect(await store.load()).toEqual({
      defaultProvider: "openai-compatible",
      providers: { "openai-compatible": { defaultModel: "test-model" } },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      defaultProvider: "openai-compatible",
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("applies CLI, config, environment, then single-credential provider priority", () => {
    const config = {
      defaultProvider: "config-provider",
      providers: { "config-provider": { defaultModel: "config-model" } },
    };
    expect(
      selectProvider({
        cliProvider: "cli-provider",
        config,
        environment: { EULR_PROVIDER: "env-provider" },
        credentialProviderIds: ["credential-provider"],
      }),
    ).toBe("cli-provider");
    expect(
      selectProvider({
        config,
        environment: { EULR_PROVIDER: "env-provider" },
        credentialProviderIds: ["credential-provider"],
      }),
    ).toBe("config-provider");
    expect(
      selectProvider({
        config: { providers: {} },
        environment: { EULR_PROVIDER: "env-provider" },
        credentialProviderIds: ["credential-provider"],
      }),
    ).toBe("env-provider");
    expect(
      selectProvider({
        config: { providers: {} },
        environment: {},
        credentialProviderIds: ["credential-provider"],
      }),
    ).toBe("credential-provider");
  });

  it("rejects absent or ambiguous implicit providers", () => {
    expect(() =>
      selectProvider({
        config: { providers: {} },
        environment: {},
        credentialProviderIds: [],
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      selectProvider({
        config: { providers: {} },
        environment: {},
        credentialProviderIds: ["one", "two"],
      }),
    ).toThrow(/more than one provider/i);
  });

  it("resolves model and base URL without crossing provider settings", () => {
    const config = {
      providers: {
        alpha: {
          defaultModel: "configured",
          baseUrl: "https://configured.example/v1",
        },
      },
    };
    expect(selectModel("alpha", "cli", config, { EULR_MODEL: "env" })).toBe(
      "cli",
    );
    expect(selectModel("alpha", undefined, config, { EULR_MODEL: "env" })).toBe(
      "configured",
    );
    expect(selectModel("beta", undefined, config, { EULR_MODEL: "env" })).toBe(
      "env",
    );
    expect(
      selectBaseUrl("alpha", config, { EULR_BASE_URL: "https://env.example" }),
    ).toBe("https://configured.example/v1");
  });

  it("loads legacy config without adding music defaults", async () => {
    const root = await temporaryRoot();
    const path = join(root, "config.json");
    await writeFile(path, '{"providers":{}}\n');

    await expect(new ConfigStore(path).load()).resolves.toEqual({
      providers: {},
    });
  });

  it("persists a model and its reasoning effort as one provider selection", async () => {
    const root = await temporaryRoot();
    const store = new ConfigStore(join(root, "config.json"));

    await store.setModelSelection("openai-codex", "gpt-5.6-sol", "max");

    expect(await store.load()).toEqual({
      providers: {
        "openai-codex": {
          defaultModel: "gpt-5.6-sol",
          defaultReasoningEffort: "max",
        },
      },
    });

    await store.setModelSelection("openai-compatible", "custom-model");
    expect((await store.load()).providers["openai-compatible"]).toEqual({
      defaultModel: "custom-model",
    });
  });

  it("validates and persists music settings", async () => {
    const root = await temporaryRoot();
    const path = join(root, "config.json");
    const store = new ConfigStore(path);

    await store.updateMusic({
      libraryPath: "/music",
      volume: 85,
      shuffle: true,
      repeat: false,
      lastTrack: "album/song.flac",
      positionSeconds: 12.5,
    });

    expect((await store.load()).music).toEqual({
      libraryPath: "/music",
      volume: 85,
      shuffle: true,
      repeat: false,
      lastTrack: "album/song.flac",
      positionSeconds: 12.5,
    });
    await expect(store.updateMusic({ volume: 101 })).rejects.toThrow();
    await expect(store.updateMusic({ positionSeconds: -1 })).rejects.toThrow();
  });

  it("serializes concurrent provider and music mutations", async () => {
    const root = await temporaryRoot();
    const path = join(root, "config.json");
    const store = new ConfigStore(path);

    await Promise.all([
      store.setDefaultModel("openai-codex", "gpt-test"),
      store.updateMusic({ volume: 42 }),
      store.updateMusic(async (music) => ({ ...music, shuffle: true })),
    ]);

    expect(await store.load()).toEqual({
      providers: { "openai-codex": { defaultModel: "gpt-test" } },
      music: { volume: 42, shuffle: true },
    });
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eulr-config-"));
  roots.push(root);
  return root;
}
