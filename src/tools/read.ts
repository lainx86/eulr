import { open, stat } from "node:fs/promises";

import { z } from "zod";

import { isBinaryBuffer } from "../utils/binary.js";
import { ToolExecutionError } from "../utils/errors.js";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  limitOutput,
} from "../utils/output-limit.js";
import { resolveWorkspacePath } from "../utils/paths.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./tool.js";

const READ_PREVIEW_MAX_CHARS = 20_000;

export const ReadInput = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .superRefine((input, context) => {
    if (
      input.startLine !== undefined &&
      input.endLine !== undefined &&
      input.endLine < input.startLine
    ) {
      context.addIssue({
        code: "custom",
        message: "endLine must be greater than or equal to startLine",
        path: ["endLine"],
      });
    }
  });

export type ReadInputValue = z.infer<typeof ReadInput>;

export interface ReadToolOptions {
  maxOutputChars?: number;
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export class ReadTool implements Tool<ReadInputValue> {
  readonly name = "read";
  readonly description =
    "Read a text file in the workspace, optionally selecting an inclusive line range.";
  readonly inputSchema = ReadInput;
  readonly permission = "read" as const;
  readonly #maxOutputChars: number;

  constructor(options: ReadToolOptions = {}) {
    this.#maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  async execute(
    input: ReadInputValue,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const resolvedPath = await resolveWorkspacePath(
      context.cwd,
      context.approvedReadPath ?? input.path,
      { mustExist: true },
    );
    if (
      context.approvedReadPath !== undefined &&
      resolvedPath !== context.approvedReadPath
    ) {
      throw new ToolExecutionError(
        `Read target changed after permission was checked: ${input.path}`,
      );
    }
    const handle = await open(resolvedPath, "r");
    let buffer: Buffer;
    try {
      const verifiedPath = await resolveWorkspacePath(
        context.cwd,
        resolvedPath,
        { mustExist: true },
      );
      if (verifiedPath !== resolvedPath) {
        throw new ToolExecutionError(
          `Read target changed before it could be opened safely: ${input.path}`,
        );
      }
      const [openedInfo, pathInfo] = await Promise.all([
        handle.stat(),
        stat(verifiedPath),
      ]);
      if (openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
        throw new ToolExecutionError(
          `Read target changed before it could be opened safely: ${input.path}`,
        );
      }
      if (!openedInfo.isFile()) {
        throw new ToolExecutionError(`Cannot read a directory: ${input.path}`);
      }
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (isBinaryBuffer(buffer)) {
      throw new ToolExecutionError(
        `Refusing to read binary file: ${input.path}`,
      );
    }

    const lines = splitLines(buffer.toString("utf8"));
    const startLine = input.startLine ?? 1;
    const endLine = Math.min(input.endLine ?? lines.length, lines.length);
    const selected: string[] = [];

    if (startLine <= endLine) {
      for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
        selected.push(`${lineNumber} | ${lines[lineNumber - 1] ?? ""}`);
      }
    }

    const body =
      selected.length > 0 ? selected.join("\n") : "[No lines in range]";
    const limited = limitOutput(`${input.path}\n${body}`, this.#maxOutputChars);
    const plainPreview =
      startLine <= endLine
        ? lines.slice(startLine - 1, endLine).join("\n")
        : "";
    const preview = limitOutput(
      plainPreview,
      Math.min(this.#maxOutputChars, READ_PREVIEW_MAX_CHARS),
    );

    return {
      content: limited.content,
      metadata: {
        path: input.path,
        startLine,
        endLine,
        totalLines: lines.length,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
        preview: preview.content,
        previewTruncated: preview.truncated,
      },
    };
  }
}

export const readTool = new ReadTool();
