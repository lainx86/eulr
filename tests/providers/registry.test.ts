import { describe, expect, it } from "vitest";

import { ProviderRegistry } from "../../src/providers/registry.js";
import type { ModelProvider } from "../../src/providers/provider.js";

function provider(id: string): ModelProvider {
  return {
    id,
    listModels: async () => [],
    stream: async function* () {
      yield { type: "done", finishReason: "stop" } as const;
    },
  };
}

describe("ProviderRegistry", () => {
  it("registers, looks up, and lists providers", () => {
    const first = provider("first");
    const registry = new ProviderRegistry([first, provider("second")]);
    expect(registry.get("first")).toBe(first);
    expect(registry.ids()).toEqual(["first", "second"]);
    expect(registry.has("second")).toBe(true);
  });

  it("rejects duplicate and unknown provider IDs", () => {
    const registry = new ProviderRegistry([provider("first")]);
    expect(() => registry.register(provider("first"))).toThrow(
      "already registered",
    );
    expect(() => registry.get("missing")).toThrow("Unknown provider");
  });
});
