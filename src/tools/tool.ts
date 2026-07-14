import type { z } from "zod";

import type { PermissionChecker } from "../permissions/types.js";

export type ToolPermission = "read" | "write" | "execute";

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  cwd: string;
  signal?: AbortSignal;
  permissions: PermissionChecker;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  approvedReadPath?: string;
}

export interface Tool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly permission: ToolPermission;

  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult>;
}
