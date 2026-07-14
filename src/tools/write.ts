import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { ToolExecutionError } from "../utils/errors.js";
import { limitOutput } from "../utils/output-limit.js";
import { resolveWorkspacePath } from "../utils/paths.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./tool.js";

const FILE_CHANGE_PREVIEW_MAX_CHARS = 20_000;

export const WriteInput = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteInputValue = z.infer<typeof WriteInput>;

function withFinalNewline(content: string): string {
  return content.length > 0 && !content.endsWith("\n")
    ? `${content}\n`
    : content;
}

async function fileState(
  filePath: string,
): Promise<{ exists: boolean; content?: Buffer }> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new ToolExecutionError(`Cannot replace a directory: ${filePath}`);
    }
    return { exists: true, content: await readFile(filePath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

export class WriteTool implements Tool<WriteInputValue> {
  readonly name = "write";
  readonly description =
    "Create a text file in the workspace or atomically replace its complete contents.";
  readonly inputSchema = WriteInput;
  readonly permission = "write" as const;

  async execute(
    input: WriteInputValue,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    let resolvedPath = await resolveWorkspacePath(context.cwd, input.path);
    await mkdir(path.dirname(resolvedPath), { recursive: true });

    // Resolve again after creating parents so a newly introduced symlink cannot
    // redirect the final write outside the workspace.
    resolvedPath = await resolveWorkspacePath(context.cwd, input.path);
    const previous = await fileState(resolvedPath);
    const content = withFinalNewline(input.content);
    const bytes = Buffer.byteLength(content);
    const unchanged = previous.content?.equals(Buffer.from(content)) ?? false;

    if (!unchanged) {
      await atomicWriteFile(resolvedPath, content);
    }

    const action = unchanged
      ? "Unchanged"
      : previous.exists
        ? "Replaced"
        : "Created";
    const fileChange = unchanged
      ? undefined
      : createFileChangeMetadata(input.path, previous.content, content);

    return {
      content: `${action} ${input.path} (${bytes} bytes)`,
      metadata: {
        path: input.path,
        bytes,
        created: !previous.exists,
        changed: !unchanged,
        ...(fileChange === undefined ? {} : { fileChange }),
      },
    };
  }
}

function createFileChangeMetadata(
  filePath: string,
  before: Buffer | undefined,
  after: string,
): {
  path: string;
  before: string | null;
  after: string;
  truncated: boolean;
} {
  const beforePreview =
    before === undefined
      ? undefined
      : limitOutput(before.toString("utf8"), FILE_CHANGE_PREVIEW_MAX_CHARS);
  const afterPreview = limitOutput(after, FILE_CHANGE_PREVIEW_MAX_CHARS);
  return {
    path: filePath,
    before: beforePreview?.content ?? null,
    after: afterPreview.content,
    truncated: (beforePreview?.truncated ?? false) || afterPreview.truncated,
  };
}

export const writeTool = new WriteTool();
