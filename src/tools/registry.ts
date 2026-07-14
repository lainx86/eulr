import { z } from "zod";

import type { PermissionRequest } from "../permissions/types.js";
import { analyzeCommandRisk } from "../permissions/command-risk.js";
import {
  isSensitivePath,
  permissionTargetPath,
} from "../permissions/permission-manager.js";
import type { ModelToolDefinition } from "../providers/provider.js";
import {
  CancellationError,
  ConfigurationError,
  PermissionDeniedError,
  ToolExecutionError,
  ToolValidationError,
  errorMessage,
  isAbortError,
} from "../utils/errors.js";
import { resolveWorkspacePath } from "../utils/paths.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolPermission,
  ToolResult,
} from "./tool.js";
import { writeTool } from "./write.js";

function inputRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : undefined;
}

function stringField(input: unknown, field: string): string | undefined {
  const value = inputRecord(input)?.[field];
  return typeof value === "string" ? value : undefined;
}

interface PreparedPermission {
  request: PermissionRequest;
  approvedReadPath?: string;
}

async function preparePermission(
  permission: ToolPermission,
  toolName: string,
  input: unknown,
  cwd: string,
): Promise<PreparedPermission> {
  if (permission === "read") {
    const filePath = stringField(input, "path");
    let sensitive = filePath !== undefined && isSensitivePath(filePath);
    let canonicalPath: string | undefined;

    if (filePath !== undefined) {
      canonicalPath = await resolveWorkspacePath(cwd, filePath, {
        mustExist: true,
      });
      sensitive ||= isSensitivePath(canonicalPath);
    }

    return {
      request: {
        category: sensitive ? "sensitive-read" : "read",
        target:
          filePath === undefined ? toolName : permissionTargetPath(filePath),
        description: sensitive
          ? "Read a file that may contain credentials or secrets"
          : "Read a workspace file",
      },
      ...(canonicalPath === undefined
        ? {}
        : { approvedReadPath: canonicalPath }),
    };
  }

  if (permission === "write") {
    const filePath = stringField(input, "path");
    return {
      request: {
        category: "write",
        target:
          filePath === undefined ? toolName : permissionTargetPath(filePath),
        description: "Create or modify a workspace file",
      },
    };
  }

  const command = stringField(input, "command") ?? toolName;
  const risk = analyzeCommandRisk(command);
  return {
    request: {
      category: risk.level === "high" ? "high-risk-execute" : "execute",
      target: command,
      description: "Run a command in the workspace",
      ...(risk.reason === undefined ? {} : { risk: risk.reason }),
    },
  };
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

function errorResult(error: Error): ToolResult {
  return {
    content: `${error.name}: ${error.message}`,
    isError: true,
    metadata: { errorType: error.name },
  };
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: Iterable<Tool> = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new ConfigurationError(`Tool is already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  definitions(): ModelToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }));
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      return errorResult(new ToolValidationError(`Unknown tool: ${name}`));
    }

    if (context.signal?.aborted) {
      throw new CancellationError(
        `Tool ${name} was cancelled before execution`,
      );
    }

    const parsed = await tool.inputSchema.safeParseAsync(input);
    if (!parsed.success) {
      return errorResult(
        new ToolValidationError(
          `Invalid arguments for ${name}: ${validationMessage(parsed.error)}`,
          { cause: parsed.error },
        ),
      );
    }

    try {
      const prepared = await preparePermission(
        tool.permission,
        tool.name,
        parsed.data,
        context.cwd,
      );
      const { request } = prepared;
      const allowed = await context.permissions.check(request);
      if (!allowed) {
        throw new PermissionDeniedError(
          `Permission denied for ${request.category}: ${request.target}`,
        );
      }
      const executionContext =
        prepared.approvedReadPath === undefined
          ? context
          : { ...context, approvedReadPath: prepared.approvedReadPath };
      return await tool.execute(parsed.data, executionContext);
    } catch (error) {
      if (context.signal?.aborted || isAbortError(error)) {
        if (error instanceof CancellationError) {
          throw error;
        }
        throw new CancellationError(`Tool ${name} was cancelled`, {
          cause: error,
        });
      }

      if (
        error instanceof ToolValidationError ||
        error instanceof ToolExecutionError ||
        error instanceof PermissionDeniedError
      ) {
        return errorResult(error);
      }

      return errorResult(
        new ToolExecutionError(`Tool ${name} failed: ${errorMessage(error)}`, {
          cause: error,
        }),
      );
    }
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([readTool, writeTool, editTool, bashTool]);
}
