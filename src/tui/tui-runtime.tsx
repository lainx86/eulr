import { render } from "ink";

import { TuiApp } from "./app.js";
import { TuiController } from "./tui-controller.js";
import {
  captureTuiConsole,
  RedactedFileLogger,
  TerminalLifecycle,
} from "./terminal-lifecycle.js";
import type { TuiStore } from "./state/tui-store.js";

export interface RunTuiOptions {
  store: TuiStore;
  controller: TuiController;
  initialTask?: string;
  debug?: boolean;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  const logger = new RedactedFileLogger();
  if (options.debug) {
    await logger.log("debug", "Starting full-screen TUI", {
      provider: options.store.getSnapshot().providerId,
      model: options.store.getSnapshot().model,
      cwd: options.store.getSnapshot().cwd,
      session: options.store.getSnapshot().sessionId,
    });
  }
  let instance: ReturnType<typeof render> | undefined;
  const restoreConsole = captureTuiConsole(logger);
  const lifecycle = new TerminalLifecycle({
    logger,
    onSignal: () => options.controller.requestExit(),
    onFatalError: (error) => {
      options.controller.requestExit(
        error instanceof Error ? error : new Error(String(error)),
      );
    },
  });

  try {
    lifecycle.install();
    instance = render(
      <TuiApp
        store={options.store}
        controller={options.controller}
        initialTask={options.initialTask}
      />,
      {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        interactive: true,
        alternateScreen: true,
        incrementalRendering: true,
        maxFps: 20,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    options.controller.bindRedraw(() => instance?.clear());
    await instance.waitUntilExit();
  } catch (error) {
    await logger
      .log("error", "TUI runtime failed", error)
      .catch(() => undefined);
    throw error;
  } finally {
    try {
      instance?.unmount();
      instance?.cleanup();
      lifecycle.dispose();
      await options.controller.shutdown().catch((error: unknown) => {
        void logger.log("warn", "TUI controller shutdown failed", error);
      });
      await lifecycle.flushLogs().catch(() => undefined);
    } finally {
      restoreConsole();
    }
  }
}
