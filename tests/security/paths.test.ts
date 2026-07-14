import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceBoundaryError } from "../../src/utils/errors.js";
import { resolveWorkspacePath } from "../../src/utils/paths.js";
import { removeWorkspace, temporaryWorkspace } from "../tools/helpers.js";

describe("resolveWorkspacePath", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  async function workspace(): Promise<string> {
    const result = await temporaryWorkspace();
    workspaces.push(result);
    return result;
  }

  it("resolves a new relative path inside the workspace", async () => {
    const cwd = await workspace();
    await mkdir(path.join(cwd, "src"));

    await expect(resolveWorkspacePath(cwd, "src/new.ts")).resolves.toBe(
      path.join(await realpath(cwd), "src/new.ts"),
    );
  });

  it("rejects relative traversal", async () => {
    const cwd = await workspace();

    await expect(
      resolveWorkspacePath(cwd, "../outside.txt"),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });

  it("rejects an absolute path outside the workspace", async () => {
    const cwd = await workspace();

    await expect(
      resolveWorkspacePath(cwd, path.join(tmpdir(), "outside-eulr.txt")),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });

  it("rejects an existing symlink escape", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(path.join(outside, "secret.txt"), path.join(cwd, "escape"));

    await expect(
      resolveWorkspacePath(cwd, "escape", { mustExist: true }),
    ).rejects.toThrow(/symbolic link/u);
  });

  it("rejects a new file beneath a symlinked parent outside the workspace", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await symlink(outside, path.join(cwd, "outside-parent"));

    await expect(
      resolveWorkspacePath(cwd, "outside-parent/new.txt"),
    ).rejects.toThrow(/symbolic link/u);
  });

  it("allows a symlink whose target remains inside the workspace", async () => {
    const cwd = await workspace();
    await mkdir(path.join(cwd, "real"));
    await symlink(path.join(cwd, "real"), path.join(cwd, "alias"));

    await expect(resolveWorkspacePath(cwd, "alias/new.txt")).resolves.toBe(
      path.join(await realpath(cwd), "real/new.txt"),
    );
  });
});
