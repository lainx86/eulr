import { describe, expect, it, vi } from "vitest";

import { PromptService } from "../../src/cli/prompts.js";

describe("PromptService permissions", () => {
  it("redacts bearer tokens and API keys before showing a command", async () => {
    const chunks: string[] = [];
    const input = { isTTY: true } as unknown as NodeJS.ReadStream;
    const output = {
      isTTY: true,
      write: vi.fn((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }),
    } as unknown as NodeJS.WriteStream;
    const prompts = new PromptService({ input, output });
    vi.spyOn(prompts, "ask").mockResolvedValue("n");

    const decision = await prompts.confirmPermission({
      category: "execute",
      target:
        "curl -H 'Authorization: Bearer command-secret' --api-key=sk-command-secret example.test",
    });

    const rendered = chunks.join("");
    expect(decision).toEqual({ allowed: false, remember: false });
    expect(rendered).not.toContain("command-secret");
    expect(rendered).not.toContain("sk-command-secret");
    expect(rendered).toContain("Authorization: [REDACTED]");
    expect(rendered).toContain("api-key=[REDACTED]");
  });
});
