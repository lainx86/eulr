import { describe, expect, it, vi } from "vitest";

import { resolveModel } from "../../src/cli/main.js";
import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
} from "../../src/providers/provider.js";
import { AuthenticationError, ProviderError } from "../../src/utils/errors.js";

function provider(models: ModelInfo[]): ModelProvider {
  return {
    id: "test-provider",
    listModels: vi.fn(async () => models),
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "done", finishReason: "stop" };
    },
  };
}

describe("CLI model resolution", () => {
  it("retains Codex catalog metadata for an explicitly selected model", async () => {
    const source = provider([{ id: "codex-model", contextWindow: 272_000 }]);

    await expect(
      resolveModel("openai-codex", "codex-model", source),
    ).resolves.toEqual({
      model: "codex-model",
      info: { id: "codex-model", contextWindow: 272_000 },
    });
    expect(source.listModels).toHaveBeenCalledOnce();
  });

  it("does not require a models endpoint for an explicit compatible model", async () => {
    const source = provider([]);

    await expect(
      resolveModel("openai-compatible", "local-model", source),
    ).resolves.toEqual({ model: "local-model" });
    expect(source.listModels).not.toHaveBeenCalled();
  });

  it("keeps an explicit Codex model usable when catalog refresh fails", async () => {
    const source: ModelProvider = {
      id: "openai-codex",
      listModels: vi.fn(async () => {
        throw new ProviderError(
          "Codex model catalog request failed: Authorization: Bearer catalog-secret",
        );
      }),
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "done", finishReason: "stop" };
      },
    };
    const warnings: string[] = [];

    await expect(
      resolveModel("openai-codex", "gpt-explicit", source, (warning) =>
        warnings.push(warning),
      ),
    ).resolves.toEqual({ model: "gpt-explicit" });
    expect(source.listModels).toHaveBeenCalledOnce();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/catalog/i);
    expect(warnings[0]).toMatch(/explicit/i);
    expect(warnings[0]).not.toContain("catalog-secret");
  });

  it("does not hide a catalog failure when no explicit Codex model exists", async () => {
    const source: ModelProvider = {
      id: "openai-codex",
      listModels: vi.fn(async () => {
        throw new ProviderError("catalog unavailable");
      }),
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "done", finishReason: "stop" };
      },
    };

    await expect(
      resolveModel("openai-codex", undefined, source),
    ).rejects.toThrow("catalog unavailable");
  });

  it("does not hide an authentication failure behind an explicit Codex model", async () => {
    const source: ModelProvider = {
      id: "openai-codex",
      listModels: vi.fn(async () => {
        throw new AuthenticationError("ChatGPT account selection failed");
      }),
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "done", finishReason: "stop" };
      },
    };
    const warnings: string[] = [];

    await expect(
      resolveModel("openai-codex", "gpt-explicit", source, (warning) =>
        warnings.push(warning),
      ),
    ).rejects.toThrow("account selection failed");
    expect(warnings).toEqual([]);
  });

  it("requires an explicit compatible model", async () => {
    await expect(
      resolveModel("openai-compatible", undefined, provider([])),
    ).rejects.toThrow("No model configured");
  });
});
