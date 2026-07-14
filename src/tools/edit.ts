import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { isBinaryBuffer } from "../utils/binary.js";
import { ToolExecutionError } from "../utils/errors.js";
import { limitOutput } from "../utils/output-limit.js";
import { resolveWorkspacePath } from "../utils/paths.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./tool.js";

const FILE_CHANGE_PREVIEW_MAX_CHARS = 20_000;

export const EditInput = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().default(false),
});

export type EditInputValue = z.infer<typeof EditInput>;

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(search, index);
    if (index < 0) {
      return count;
    }
    count += 1;
    index += search.length;
  }
}

export class EditTool implements Tool<EditInputValue> {
  readonly name = "edit";
  readonly description =
    "Atomically replace an exact text occurrence in a workspace file.";
  readonly inputSchema = EditInput;
  readonly permission = "write" as const;

  async execute(
    input: EditInputValue,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const resolvedPath = await resolveWorkspacePath(context.cwd, input.path, {
      mustExist: true,
    });
    const info = await stat(resolvedPath);
    if (!info.isFile()) {
      throw new ToolExecutionError(`Cannot edit a directory: ${input.path}`);
    }

    const buffer = await readFile(resolvedPath);
    if (isBinaryBuffer(buffer)) {
      throw new ToolExecutionError(
        `Refusing to edit binary file: ${input.path}`,
      );
    }

    const content = buffer.toString("utf8");
    const matches = countOccurrences(content, input.oldText);
    if (matches === 0) {
      throw new ToolExecutionError(`Exact text was not found in ${input.path}`);
    }
    if (matches > 1 && !input.replaceAll) {
      throw new ToolExecutionError(
        `Exact text occurs ${matches} times in ${input.path}; set replaceAll to edit every occurrence`,
      );
    }

    const replacements = input.replaceAll ? matches : 1;
    const updated = input.replaceAll
      ? content.split(input.oldText).join(input.newText)
      : content.replace(input.oldText, input.newText);
    await atomicWriteFile(resolvedPath, updated);
    const changed = updated !== content;

    return {
      content: `Edited ${input.path} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
      metadata: {
        path: input.path,
        replacements,
        changed,
        ...(changed
          ? {
              fileChange: createFileChangeMetadata(
                input.path,
                content,
                updated,
              ),
            }
          : {}),
      },
    };
  }
}

function createFileChangeMetadata(
  filePath: string,
  before: string,
  after: string,
): {
  path: string;
  before: string;
  after: string;
  truncated: boolean;
} {
  const beforePreview = limitOutput(before, FILE_CHANGE_PREVIEW_MAX_CHARS);
  const afterPreview = limitOutput(after, FILE_CHANGE_PREVIEW_MAX_CHARS);
  return {
    path: filePath,
    before: beforePreview.content,
    after: afterPreview.content,
    truncated: beforePreview.truncated || afterPreview.truncated,
  };
}

export const editTool = new EditTool();
