import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { WorkspaceBoundaryError } from "./errors.js";

export interface ResolveWorkspacePathOptions {
  mustExist?: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function existsAsDirectory(directory: string): Promise<void> {
  let info;
  try {
    info = await stat(directory);
  } catch (error) {
    throw new WorkspaceBoundaryError(
      `Working directory is not available: ${directory}`,
      { cause: error },
    );
  }

  if (!info.isDirectory()) {
    throw new WorkspaceBoundaryError(
      `Working directory is not a directory: ${directory}`,
    );
  }
}

async function nearestExistingPath(
  candidate: string,
): Promise<{ existing: string; suffix: string[] }> {
  let current = candidate;
  const suffix: string[] = [];

  while (true) {
    try {
      await lstat(current);
      return { existing: current, suffix };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new WorkspaceBoundaryError(`Cannot resolve path: ${candidate}`);
    }

    suffix.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Resolves a user-supplied path against a workspace and canonicalizes every
 * existing component. New paths are rebuilt from their nearest real parent.
 */
export async function resolveWorkspacePath(
  workspace: string,
  requestedPath: string,
  options: ResolveWorkspacePathOptions = {},
): Promise<string> {
  if (requestedPath.length === 0 || requestedPath.includes("\0")) {
    throw new WorkspaceBoundaryError(
      "Path must be a non-empty filesystem path",
    );
  }

  const workspaceAbsolute = path.resolve(workspace);
  await existsAsDirectory(workspaceAbsolute);
  const workspaceReal = await realpath(workspaceAbsolute);
  const candidate = path.resolve(workspaceAbsolute, requestedPath);

  // A lexical check rejects traversal before probing paths outside the root.
  if (
    !isWithin(workspaceAbsolute, candidate) &&
    !isWithin(workspaceReal, candidate)
  ) {
    throw new WorkspaceBoundaryError(
      `Path is outside the workspace: ${requestedPath}`,
    );
  }

  const { existing, suffix } = await nearestExistingPath(candidate);
  let existingReal: string;
  try {
    existingReal = await realpath(existing);
  } catch (error) {
    throw new WorkspaceBoundaryError(
      `Path contains an unresolved symbolic link: ${requestedPath}`,
      { cause: error },
    );
  }

  if (!isWithin(workspaceReal, existingReal)) {
    throw new WorkspaceBoundaryError(
      `Path escapes the workspace through a symbolic link: ${requestedPath}`,
    );
  }

  if (options.mustExist && suffix.length > 0) {
    throw new WorkspaceBoundaryError(`Path does not exist: ${requestedPath}`);
  }

  const resolved = path.resolve(existingReal, ...suffix);
  if (!isWithin(workspaceReal, resolved)) {
    throw new WorkspaceBoundaryError(
      `Path is outside the workspace: ${requestedPath}`,
    );
  }

  return resolved;
}

export async function getWorkspaceRealPath(workspace: string): Promise<string> {
  return resolveWorkspacePath(workspace, ".", { mustExist: true });
}
