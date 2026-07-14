import { z } from "zod";

import { describe, expect, it, vi } from "vitest";

import type { Tool } from "../../src/tools/tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const EchoInput = z.object({ value: z.string().min(1) });

function echoTool(
  execute: Tool<z.infer<typeof EchoInput>>["execute"] = async (input) => ({
    content: input.value,
  }),
): Tool<z.infer<typeof EchoInput>> {
  return {
    name: "echo",
    description: "Echo a value",
    inputSchema: EchoInput,
    permission: "read",
    execute,
  };
}

function context(allowed = true) {
  return {
    cwd: process.cwd(),
    permissions: {
      check: vi.fn(async () => allowed),
    },
  };
}

describe("ToolRegistry", () => {
  it("registers and exposes provider-neutral JSON schema definitions", () => {
    const registry = new ToolRegistry([echoTool()]);

    expect(registry.get("echo")).toBeDefined();
    expect(registry.list()).toHaveLength(1);
    expect(registry.definitions()).toEqual([
      expect.objectContaining({
        name: "echo",
        description: "Echo a value",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
    ]);
  });

  it("prevents duplicate names", () => {
    const registry = new ToolRegistry([echoTool()]);
    expect(() => registry.register(echoTool())).toThrow(/already registered/u);
  });

  it("returns an error result for unknown tools and preserves the name", async () => {
    const result = await new ToolRegistry().execute(
      "missing-tool",
      {},
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing-tool");
  });

  it("validates input before checking permission", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const executionContext = context();

    const result = await registry.execute(
      "echo",
      { value: 4 },
      executionContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid arguments");
    expect(executionContext.permissions.check).not.toHaveBeenCalled();
  });

  it("normalizes permission denial", async () => {
    const result = await new ToolRegistry([echoTool()]).execute(
      "echo",
      { value: "hello" },
      context(false),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("PermissionDeniedError");
  });

  it("normalizes errors thrown by tool execution", async () => {
    const result = await new ToolRegistry([
      echoTool(async () => {
        throw new Error("exploded");
      }),
    ]).execute("echo", { value: "hello" }, context());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exploded");
  });

  it("executes a valid tool call", async () => {
    const result = await new ToolRegistry([echoTool()]).execute(
      "echo",
      { value: "hello" },
      context(),
    );

    expect(result).toEqual({ content: "hello" });
  });
});
