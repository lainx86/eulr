import { symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isSensitivePath,
  PermissionManager,
} from "../../src/permissions/permission-manager.js";
import type { PermissionRequest } from "../../src/permissions/types.js";
import { BashTool } from "../../src/tools/bash.js";
import { ReadTool } from "../../src/tools/read.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { removeWorkspace, temporaryWorkspace } from "../tools/helpers.js";

describe("sensitive path classification", () => {
  it.each([
    ".env",
    ".env.local",
    "config/private.pem",
    "tls/server.key",
    ".ssh/id_rsa",
    ".ssh/id_ed25519",
    "credentials.json",
    ".eulr/auth.json",
  ])("classifies %s as sensitive", (filePath) => {
    expect(isSensitivePath(filePath)).toBe(true);
  });

  it.each(["src/env.ts", "public/key.svg", "auth.json.example"])(
    "does not classify %s as sensitive",
    (filePath) => {
      expect(isSensitivePath(filePath)).toBe(false);
    },
  );
});

describe("PermissionManager", () => {
  it("automatically permits ordinary reads", async () => {
    const prompt = vi.fn();
    const manager = new PermissionManager({ prompt });

    await expect(
      manager.check({ category: "read", target: "src/index.ts" }),
    ).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("--yes permits normal writes and commands, but not protected categories", async () => {
    const manager = new PermissionManager({ yes: true });

    await expect(
      manager.check({ category: "write", target: "src/index.ts" }),
    ).resolves.toBe(true);
    await expect(
      manager.check({ category: "execute", target: "pnpm test" }),
    ).resolves.toBe(true);
    await expect(
      manager.check({ category: "sensitive-read", target: ".env" }),
    ).resolves.toBe(false);
    await expect(
      manager.check({ category: "high-risk-execute", target: "rm -rf /" }),
    ).resolves.toBe(false);
  });

  it("remembers an approved category for the active session", async () => {
    const prompt = vi.fn(async () => ({ allowed: true, remember: true }));
    const manager = new PermissionManager({ prompt });
    const request: PermissionRequest = {
      category: "write",
      target: "one.ts",
    };

    await expect(manager.check(request)).resolves.toBe(true);
    await expect(manager.check({ ...request, target: "two.ts" })).resolves.toBe(
      true,
    );
    expect(prompt).toHaveBeenCalledTimes(1);

    manager.clearSessionApprovals();
    await manager.check({ ...request, target: "three.ts" });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("requires explicit confirmation for every high-risk command", async () => {
    const prompt = vi.fn(async () => ({ allowed: true, remember: true }));
    const manager = new PermissionManager({ yes: true, prompt });
    const request: PermissionRequest = {
      category: "high-risk-execute",
      target: "git reset --hard",
      risk: "discards changes",
    };

    await expect(manager.check(request)).resolves.toBe(true);
    await expect(manager.check(request)).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});

describe("dynamic registry permissions", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  async function workspace(): Promise<string> {
    const result = await temporaryWorkspace();
    workspaces.push(result);
    return result;
  }

  it("requests sensitive-read before reading a credential file", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, ".env"), "TOKEN=secret\n");
    const check = vi.fn(async () => false);
    const registry = new ToolRegistry([new ReadTool()]);

    const result = await registry.execute(
      "read",
      { path: ".env" },
      {
        cwd,
        permissions: { check },
      },
    );

    expect(result.isError).toBe(true);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ category: "sensitive-read", target: ".env" }),
    );
    expect(result.content).not.toContain("TOKEN=secret");
  });

  it("classifies a harmless-looking symlink by its canonical target", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, ".env"), "TOKEN=canonical-secret\n");
    await symlink(".env", path.join(cwd, "public-config"));
    const check = vi.fn(async () => false);
    const registry = new ToolRegistry([new ReadTool()]);

    const result = await registry.execute(
      "read",
      { path: "public-config" },
      { cwd, permissions: { check } },
    );

    expect(result.isError).toBe(true);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "sensitive-read",
        target: "public-config",
      }),
    );
    expect(result.content).not.toContain("canonical-secret");
  });

  it("reads the path classified before permission if a symlink changes", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "ordinary.txt"), "ordinary-content\n");
    await writeFile(path.join(cwd, ".env"), "TOKEN=raced-secret\n");
    const alias = path.join(cwd, "config-link");
    await symlink("ordinary.txt", alias);
    const check = vi.fn(async () => {
      await unlink(alias);
      await symlink(".env", alias);
      return true;
    });
    const registry = new ToolRegistry([new ReadTool()]);

    const result = await registry.execute(
      "read",
      { path: "config-link" },
      { cwd, permissions: { check } },
    );

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ category: "read", target: "config-link" }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("ordinary-content");
    expect(result.content).not.toContain("raced-secret");
  });

  it("rejects a canonical target replaced by a sensitive symlink", async () => {
    const cwd = await workspace();
    const ordinary = path.join(cwd, "ordinary.txt");
    await writeFile(ordinary, "ordinary-content\n");
    await writeFile(path.join(cwd, ".env"), "TOKEN=replaced-secret\n");
    const check = vi.fn(async () => {
      await unlink(ordinary);
      await symlink(".env", ordinary);
      return true;
    });
    const registry = new ToolRegistry([new ReadTool()]);

    const result = await registry.execute(
      "read",
      { path: "ordinary.txt" },
      { cwd, permissions: { check } },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("changed after permission");
    expect(result.content).not.toContain("replaced-secret");
  });

  it("requests high-risk-execute with a specific risk explanation", async () => {
    const cwd = await workspace();
    const check = vi.fn(async () => false);
    const registry = new ToolRegistry([new BashTool()]);

    const result = await registry.execute(
      "bash",
      { command: "git reset --hard HEAD" },
      { cwd, permissions: { check } },
    );

    expect(result.isError).toBe(true);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "high-risk-execute",
        risk: expect.stringContaining("discards"),
      }),
    );
  });

  it("does not let --yes auto-approve a command that reads a secret", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, ".env"), "TOKEN=secret\n");
    const prompt = vi.fn(async () => ({ allowed: false, remember: false }));
    const permissions = new PermissionManager({ yes: true, prompt });
    const registry = new ToolRegistry([new BashTool()]);

    const result = await registry.execute(
      "bash",
      { command: "cat .env" },
      { cwd, permissions },
    );

    expect(result.isError).toBe(true);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "high-risk-execute",
        risk: expect.stringContaining("credentials"),
      }),
    );
    expect(result.content).not.toContain("TOKEN=secret");
  });
});
