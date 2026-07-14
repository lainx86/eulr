import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PermissionChecker } from "../../src/permissions/types.js";
import type { ToolExecutionContext } from "../../src/tools/tool.js";

export const allowAllPermissions: PermissionChecker = {
  async check() {
    return true;
  },
};

export async function temporaryWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "eulr-tools-"));
}

export async function removeWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { force: true, recursive: true });
}

export function toolContext(
  cwd: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    cwd,
    permissions: allowAllPermissions,
    ...overrides,
  };
}

export function nodeCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}
