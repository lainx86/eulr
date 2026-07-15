import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getEulrPaths } from "../../src/config/data-paths.js";
import {
  captureTuiConsole,
  configureTuiColorEnvironment,
  RedactedFileLogger,
  TERMINAL_ESCAPE_SEQUENCES,
  TERMINAL_RESTORE_SEQUENCE,
  TerminalLifecycle,
  supportsTui,
} from "../../src/tui/terminal-lifecycle.js";
import type {
  ProcessEventSource,
  TerminalLogger,
  TuiConsole,
} from "../../src/tui/terminal-lifecycle.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("supportsTui", () => {
  it("requires TTY input/output and a usable terminal", () => {
    expect(
      supportsTui({
        input: { isTTY: true },
        output: { isTTY: true },
        environment: { TERM: "xterm-256color" },
      }),
    ).toBe(true);
    expect(
      supportsTui({
        input: { isTTY: false },
        output: { isTTY: true },
        environment: { TERM: "xterm" },
      }),
    ).toBe(false);
    expect(
      supportsTui({
        input: { isTTY: true },
        output: { isTTY: true },
        environment: { TERM: "dumb" },
      }),
    ).toBe(false);
  });

  it("enables painted TUI surfaces even when plain output disables color", () => {
    const trueColorEnvironment: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      COLORTERM: "truecolor",
    };
    configureTuiColorEnvironment(trueColorEnvironment);
    expect(trueColorEnvironment.NO_COLOR).toBeUndefined();
    expect(trueColorEnvironment.FORCE_COLOR).toBe("3");

    const indexedColorEnvironment: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      TERM: "xterm-256color",
    };
    configureTuiColorEnvironment(indexedColorEnvironment);
    expect(indexedColorEnvironment.NO_COLOR).toBeUndefined();
    expect(indexedColorEnvironment.FORCE_COLOR).toBe("2");
  });
});

describe("TerminalLifecycle", () => {
  it("restores raw mode, paste, attributes, alternate screen, and cursor once", () => {
    const setRawMode = vi.fn();
    const write = vi.fn();
    const lifecycle = new TerminalLifecycle({
      input: { isTTY: true, isRaw: true, setRawMode },
      output: { isTTY: true, write },
      eventSource: fakeEventSource().source,
      logger: memoryLogger(),
    });

    lifecycle.cleanup();
    lifecycle.cleanup();

    expect(setRawMode).toHaveBeenCalledOnce();
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(TERMINAL_RESTORE_SEQUENCE);
    expect(TERMINAL_RESTORE_SEQUENCE).toContain(
      TERMINAL_ESCAPE_SEQUENCES.disableBracketedPaste,
    );
    expect(TERMINAL_RESTORE_SEQUENCE).toContain(
      TERMINAL_ESCAPE_SEQUENCES.leaveAlternateScreen,
    );
    expect(TERMINAL_RESTORE_SEQUENCE).toContain(
      TERMINAL_ESCAPE_SEQUENCES.showCursor,
    );
  });

  it("registers callbacks without deciding process exit", () => {
    const events = fakeEventSource();
    const onSignal = vi.fn();
    const onFatalError = vi.fn();
    const lifecycle = new TerminalLifecycle({
      input: { isTTY: true, setRawMode: vi.fn() },
      output: { isTTY: true, write: vi.fn() },
      eventSource: events.source,
      logger: memoryLogger(),
      onSignal,
      onFatalError,
    }).install();

    lifecycle.install();
    expect(events.emitter.listenerCount("SIGINT")).toBe(1);
    expect(events.emitter.listenerCount("SIGTERM")).toBe(1);
    expect(events.emitter.listenerCount("uncaughtException")).toBe(1);
    expect(events.emitter.listenerCount("unhandledRejection")).toBe(1);

    events.emitter.emit("SIGINT");
    const failure = new Error("access_token=do-not-print");
    events.emitter.emit("unhandledRejection", failure, Promise.resolve());

    expect(onSignal).toHaveBeenCalledWith("SIGINT");
    expect(onFatalError).toHaveBeenCalledWith(failure, "unhandledRejection");
    expect(events.exit).not.toHaveBeenCalled();

    lifecycle.dispose();
    expect(events.emitter.listenerCount("SIGINT")).toBe(0);
    expect(events.emitter.listenerCount("SIGTERM")).toBe(0);
    expect(events.emitter.listenerCount("uncaughtException")).toBe(0);
    expect(events.emitter.listenerCount("unhandledRejection")).toBe(0);
  });

  it("does not write restoration escapes to non-TTY output", () => {
    const write = vi.fn();
    new TerminalLifecycle({
      input: { isTTY: false, setRawMode: vi.fn() },
      output: { isTTY: false, write },
      eventSource: fakeEventSource().source,
      logger: memoryLogger(),
    }).cleanup();

    expect(write).not.toHaveBeenCalled();
  });
});

describe("captureTuiConsole", () => {
  it("redirects sanitized diagnostics and restores console methods", () => {
    const log = vi.fn();
    const originalError = vi.fn();
    const target: TuiConsole = {
      debug: vi.fn(),
      error: originalError,
      info: vi.fn(),
      log: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };
    const restore = captureTuiConsole({ log }, target);

    target.error("Authorization: Bearer top-secret");
    expect(originalError).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "error",
      "TUI console output",
      "Authorization: [REDACTED]",
    );

    restore();
    restore();
    target.error("visible after restore");
    expect(originalError).toHaveBeenCalledWith("visible after restore");
  });
});

describe("RedactedFileLogger", () => {
  it("writes private JSONL diagnostics with credential redaction", async () => {
    const root = await temporaryRoot();
    const paths = getEulrPaths(root);
    const logger = new RedactedFileLogger({
      paths,
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    });

    await logger.log("error", "Authorization: Bearer access.secret", {
      refreshToken: "refresh-secret",
      safe: "visible",
    });
    await logger.flush();

    const contents = await readFile(logger.filePath, "utf8");
    expect(logger.filePath).toBe(join(root, "logs", "eulr.log"));
    expect(contents).toContain("[REDACTED]");
    expect(contents).toContain("visible");
    expect(contents).not.toContain("access.secret");
    expect(contents).not.toContain("refresh-secret");
    expect(JSON.parse(contents.trim())).toMatchObject({
      timestamp: "2026-07-15T00:00:00.000Z",
      level: "error",
    });

    if (process.platform !== "win32") {
      expect((await stat(join(root, "logs"))).mode & 0o777).toBe(0o700);
      expect((await stat(logger.filePath)).mode & 0o777).toBe(0o600);
    }
  });
});

function fakeEventSource(): {
  emitter: EventEmitter;
  source: ProcessEventSource;
  exit: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  return {
    emitter,
    source: emitter as unknown as ProcessEventSource,
    exit: vi.fn(),
  };
}

function memoryLogger(): TerminalLogger {
  return { log: vi.fn() };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eulr-tui-"));
  temporaryRoots.push(root);
  return root;
}
