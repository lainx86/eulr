import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { z } from "zod";

import { CancellationError, ToolExecutionError } from "../utils/errors.js";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  HeadTailOutputBuffer,
} from "../utils/output-limit.js";
import { getWorkspaceRealPath } from "../utils/paths.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./tool.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const FORCE_KILL_DELAY_MS = 1_000;

export const BashInput = z.object({
  command: z.string().min(1),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60 * 1000)
    .optional(),
});

export type BashInputValue = z.infer<typeof BashInput>;

export interface BashToolOptions {
  maxOutputChars?: number;
  defaultTimeoutMs?: number;
  forceKillDelayMs?: number;
  shell?: string;
}

function shellInvocation(
  command: string,
  configuredShell?: string,
): {
  executable: string;
  arguments: string[];
} {
  if (process.platform === "win32") {
    return {
      executable: configuredShell ?? process.env.ComSpec ?? "cmd.exe",
      arguments: ["/d", "/s", "/c", command],
    };
  }

  return {
    executable: configuredShell ?? "/bin/sh",
    arguments: ["-c", command],
  };
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the close check and this signal.
  }
}

export class BashTool implements Tool<BashInputValue> {
  readonly name = "bash";
  readonly description =
    "Run a shell command from the workspace and return bounded stdout, stderr, and exit status.";
  readonly inputSchema = BashInput;
  readonly permission = "execute" as const;
  readonly #maxOutputChars: number;
  readonly #defaultTimeoutMs: number;
  readonly #forceKillDelayMs: number;
  readonly #shell?: string;

  constructor(options: BashToolOptions = {}) {
    this.#maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#forceKillDelayMs = options.forceKillDelayMs ?? FORCE_KILL_DELAY_MS;
    this.#shell = options.shell;
  }

  async execute(
    input: BashInputValue,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (context.signal?.aborted) {
      throw new CancellationError("Command cancelled before it started");
    }

    const cwd = await getWorkspaceRealPath(context.cwd);
    if (context.signal?.aborted) {
      throw new CancellationError("Command cancelled before it started");
    }

    const timeoutMs = input.timeoutMs ?? this.#defaultTimeoutMs;
    const invocation = shellInvocation(input.command, this.#shell);
    const streamLimit = Math.max(1, Math.floor(this.#maxOutputChars / 2));
    const stdout = new HeadTailOutputBuffer(streamLimit);
    const stderr = new HeadTailOutputBuffer(streamLimit);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const child = spawn(invocation.executable, invocation.arguments, {
      cwd,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    return await new Promise<ToolResult>((resolve, reject) => {
      let cancelled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const emitOutput = (stream: "stdout" | "stderr", chunk: string): void => {
        if (chunk.length === 0) {
          return;
        }
        if (stream === "stdout") {
          stdout.append(chunk);
        } else {
          stderr.append(chunk);
        }
        try {
          context.onOutput?.(stream, chunk);
        } catch {
          // Rendering callbacks must not make command execution fail.
        }
      };

      const beginTermination = (): void => {
        signalProcessGroup(child, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          signalProcessGroup(child, "SIGKILL");
        }, this.#forceKillDelayMs);
        forceKillTimer.unref();
      };

      const onAbort = (): void => {
        if (settled || cancelled) {
          return;
        }
        cancelled = true;
        beginTermination();
      };

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;
        beginTermination();
      }, timeoutMs);
      timeout.unref();

      child.stdout?.on("data", (chunk: Buffer) => {
        emitOutput("stdout", stdoutDecoder.write(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        emitOutput("stderr", stderrDecoder.write(chunk));
      });

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        context.signal?.removeEventListener("abort", onAbort);
        reject(
          new ToolExecutionError(
            `Failed to start command shell: ${error.message}`,
            { cause: error },
          ),
        );
      });

      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        context.signal?.removeEventListener("abort", onAbort);
        emitOutput("stdout", stdoutDecoder.end());
        emitOutput("stderr", stderrDecoder.end());

        if (cancelled) {
          reject(new CancellationError("Command cancelled"));
          return;
        }

        const stdoutResult = stdout.result();
        const stderrResult = stderr.result();
        const status = timedOut
          ? `Timed out after ${timeoutMs} ms`
          : `Exit code: ${exitCode ?? "none"}`;
        const signalLine = signal === null ? "" : `\nSignal: ${signal}`;
        const content = [
          `Command: ${input.command}`,
          `${status}${signalLine}`,
          "",
          "stdout:",
          stdoutResult.content || "(empty)",
          "",
          "stderr:",
          stderrResult.content || "(empty)",
        ].join("\n");

        resolve({
          content,
          isError: timedOut || exitCode !== 0,
          metadata: {
            command: input.command,
            exitCode,
            signal,
            timedOut,
            stdout: stdoutResult.content,
            stderr: stderrResult.content,
            stdoutTruncated: stdoutResult.truncated,
            stderrTruncated: stderrResult.truncated,
          },
        });
      });

      context.signal?.addEventListener("abort", onAbort, { once: true });
      if (context.signal?.aborted) {
        onAbort();
      }
    });
  }
}

export const bashTool = new BashTool();
