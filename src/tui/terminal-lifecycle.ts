import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactText, redactValue } from "../auth/redaction.js";
import { getEulrPaths } from "../config/data-paths.js";
import type { EulrPaths } from "../config/data-paths.js";

export const TERMINAL_ESCAPE_SEQUENCES = Object.freeze({
  enterAlternateScreen: "\u001b[?1049h",
  leaveAlternateScreen: "\u001b[?1049l",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  enableBracketedPaste: "\u001b[?2004h",
  disableBracketedPaste: "\u001b[?2004l",
  resetAttributes: "\u001b[0m",
});

export const TERMINAL_RESTORE_SEQUENCE = [
  TERMINAL_ESCAPE_SEQUENCES.disableBracketedPaste,
  TERMINAL_ESCAPE_SEQUENCES.resetAttributes,
  TERMINAL_ESCAPE_SEQUENCES.leaveAlternateScreen,
  TERMINAL_ESCAPE_SEQUENCES.showCursor,
].join("");

export interface TerminalInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
}

export interface TerminalOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): unknown;
}

export interface SupportsTuiOptions {
  input?: Pick<TerminalInput, "isTTY">;
  output?: Pick<TerminalOutput, "isTTY">;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Full-screen TUI surfaces must paint every cell, even when plain CLI output
 * is configured with NO_COLOR. Call this before importing Ink.
 */
export function configureTuiColorEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  delete environment.NO_COLOR;
  const colorTerminal = environment.COLORTERM?.toLowerCase() ?? "";
  environment.FORCE_COLOR = /truecolor|24bit/u.test(colorTerminal) ? "3" : "2";
}

export function supportsTui(options: SupportsTuiOptions = {}): boolean {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const environment = options.environment ?? process.env;
  return (
    input.isTTY === true &&
    output.isTTY === true &&
    environment.TERM?.toLowerCase() !== "dumb"
  );
}

export function restoreRawMode(input: TerminalInput): void {
  if (input.isTTY === true && input.setRawMode !== undefined) {
    input.setRawMode(false);
  }
}

export type TerminalLogLevel = "debug" | "info" | "warn" | "error";

export interface TerminalLogger {
  log(
    level: TerminalLogLevel,
    message: string,
    details?: unknown,
  ): void | Promise<void>;
  flush?(): Promise<void>;
}

export interface RedactedFileLoggerOptions {
  paths?: EulrPaths;
  filePath?: string;
  now?: () => Date;
}

export function terminalLogPath(paths: EulrPaths = getEulrPaths()): string {
  return join(paths.home, "logs", "eulr.log");
}

export class RedactedFileLogger implements TerminalLogger {
  readonly filePath: string;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RedactedFileLoggerOptions = {}) {
    this.filePath =
      options.filePath ?? terminalLogPath(options.paths ?? getEulrPaths());
    this.now = options.now ?? (() => new Date());
  }

  log(
    level: TerminalLogLevel,
    message: string,
    details?: unknown,
  ): Promise<void> {
    const record = {
      timestamp: this.now().toISOString(),
      level,
      message: redactText(message),
      ...(details === undefined ? {} : { details: prepareLogDetails(details) }),
    };
    const line = `${stringifyLogRecord(record)}\n`;
    const operation = this.queue.then(async () => {
      const directory = dirname(this.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        await chmod(directory, 0o700);
      }
      await appendFile(this.filePath, line, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (process.platform !== "win32") {
        await chmod(this.filePath, 0o600);
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

export type TerminalProcessEvent =
  "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection";

export type ProcessEventListener = (...arguments_: unknown[]) => void;

export interface ProcessEventSource {
  on(event: TerminalProcessEvent, listener: ProcessEventListener): unknown;
  off?(event: TerminalProcessEvent, listener: ProcessEventListener): unknown;
  removeListener?(
    event: TerminalProcessEvent,
    listener: ProcessEventListener,
  ): unknown;
}

export type TerminalFatalOrigin = "uncaughtException" | "unhandledRejection";

export interface TerminalLifecycleOptions {
  input?: TerminalInput;
  output?: TerminalOutput;
  eventSource?: ProcessEventSource;
  logger?: TerminalLogger;
  onSignal?: (signal: "SIGINT" | "SIGTERM") => void | Promise<void>;
  onFatalError?: (
    error: unknown,
    origin: TerminalFatalOrigin,
  ) => void | Promise<void>;
}

export class TerminalLifecycle {
  private readonly input: TerminalInput;
  private readonly output: TerminalOutput;
  private readonly eventSource: ProcessEventSource;
  private readonly logger: TerminalLogger;
  private readonly onSignal:
    ((signal: "SIGINT" | "SIGTERM") => void | Promise<void>) | undefined;
  private readonly onFatalError:
    | ((error: unknown, origin: TerminalFatalOrigin) => void | Promise<void>)
    | undefined;
  private installed = false;
  private cleanedUp = false;

  private readonly handleSigint: ProcessEventListener = () => {
    this.handleSignal("SIGINT");
  };

  private readonly handleSigterm: ProcessEventListener = () => {
    this.handleSignal("SIGTERM");
  };

  private readonly handleUncaughtException: ProcessEventListener = (error) => {
    this.handleFatal(error, "uncaughtException");
  };

  private readonly handleUnhandledRejection: ProcessEventListener = (
    reason,
  ) => {
    this.handleFatal(reason, "unhandledRejection");
  };

  constructor(options: TerminalLifecycleOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.eventSource =
      options.eventSource ?? (process as unknown as ProcessEventSource);
    this.logger = options.logger ?? new RedactedFileLogger();
    this.onSignal = options.onSignal;
    this.onFatalError = options.onFatalError;
  }

  get isInstalled(): boolean {
    return this.installed;
  }

  get isCleanedUp(): boolean {
    return this.cleanedUp;
  }

  install(): this {
    if (this.installed) return this;
    this.eventSource.on("SIGINT", this.handleSigint);
    this.eventSource.on("SIGTERM", this.handleSigterm);
    this.eventSource.on("uncaughtException", this.handleUncaughtException);
    this.eventSource.on("unhandledRejection", this.handleUnhandledRejection);
    this.installed = true;
    return this;
  }

  uninstall(): this {
    if (!this.installed) return this;
    this.removeListener("SIGINT", this.handleSigint);
    this.removeListener("SIGTERM", this.handleSigterm);
    this.removeListener("uncaughtException", this.handleUncaughtException);
    this.removeListener("unhandledRejection", this.handleUnhandledRejection);
    this.installed = false;
    return this;
  }

  cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    try {
      restoreRawMode(this.input);
    } catch (error) {
      this.writeLog("warn", "Unable to restore terminal raw mode", error);
    }

    if (this.output.isTTY === true) {
      try {
        this.output.write(TERMINAL_RESTORE_SEQUENCE);
      } catch (error) {
        this.writeLog("warn", "Unable to restore terminal display", error);
      }
    }
  }

  dispose(): void {
    this.uninstall();
    this.cleanup();
  }

  async flushLogs(): Promise<void> {
    await this.logger.flush?.();
  }

  private handleSignal(signal: "SIGINT" | "SIGTERM"): void {
    this.cleanup();
    this.writeLog("info", `Received ${signal}`);
    this.invokeCallback(() => this.onSignal?.(signal));
  }

  private handleFatal(error: unknown, origin: TerminalFatalOrigin): void {
    this.cleanup();
    this.writeLog("error", `Terminal runtime ${origin}`, error);
    this.invokeCallback(() => this.onFatalError?.(error, origin));
  }

  private invokeCallback(callback: () => void | Promise<void>): void {
    try {
      const result = callback();
      if (result !== undefined) {
        void result.catch((error: unknown) => {
          this.writeLog("error", "Terminal lifecycle callback failed", error);
        });
      }
    } catch (error) {
      this.writeLog("error", "Terminal lifecycle callback failed", error);
    }
  }

  private writeLog(
    level: TerminalLogLevel,
    message: string,
    details?: unknown,
  ): void {
    try {
      const operation = this.logger.log(level, message, details);
      if (operation !== undefined) void operation.catch(() => undefined);
    } catch {
      // Terminal restoration must never fail because diagnostics could not be written.
    }
  }

  private removeListener(
    event: TerminalProcessEvent,
    listener: ProcessEventListener,
  ): void {
    if (this.eventSource.off !== undefined) {
      this.eventSource.off(event, listener);
    } else {
      this.eventSource.removeListener?.(event, listener);
    }
  }
}

function prepareLogDetails(details: unknown): unknown {
  if (details instanceof Error) {
    return redactValue({
      name: details.name,
      message: details.message,
      stack: details.stack,
      cause: details.cause,
    });
  }
  return redactValue(details);
}

function stringifyLogRecord(record: unknown): string {
  return JSON.stringify(record, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}
