import type { Agent } from "../agent/agent.js";
import type { AgentLoop } from "../agent/loop.js";
import type { ModelProvider } from "../providers/provider.js";
import type { SessionService } from "../sessions/session-service.js";
import type { SessionState } from "../sessions/state.js";
import { CancellationError, isAbortError } from "../utils/errors.js";
import { INTERACTIVE_HELP, parseInteractiveCommand } from "./commands.js";
import type { PromptService } from "./prompts.js";
import type { TerminalRenderer } from "./renderer.js";

export interface InteractiveRuntime {
  providerId: string;
  provider: ModelProvider;
  model: string;
  cwd: string;
  session: SessionState;
  sessions: SessionService;
  loop: AgentLoop;
  agent: Agent;
}

export interface InteractiveOptions {
  runtime: InteractiveRuntime;
  prompts: PromptService;
  renderer: TerminalRenderer;
  cancellation: CancellationCoordinator;
  login(signal: AbortSignal): Promise<InteractiveRuntime>;
  logout(providerId: string): Promise<boolean>;
  newSession(runtime: InteractiveRuntime): Promise<InteractiveRuntime>;
  resume(sessionId: string): Promise<InteractiveRuntime>;
  saveModel(providerId: string, modelId: string): Promise<void>;
}

export class CancellationCoordinator {
  private active?: AbortController;
  private prompt?: AbortController;
  private installed = false;
  private terminateAfterOperation = false;
  exitRequested = false;

  readonly onSigint = (): void => {
    if (this.active !== undefined) {
      if (this.active.signal.aborted) {
        this.exitRequested = true;
        this.terminateAfterOperation = true;
      } else {
        this.active.abort(new CancellationError("Cancelled by Ctrl+C"));
      }
      return;
    }
    this.exitRequested = true;
    this.prompt?.abort(new CancellationError("Cancelled by Ctrl+C"));
  };

  readonly onSigterm = (): void => {
    this.exitRequested = true;
    this.terminateAfterOperation = true;
    this.active?.abort(new CancellationError("Terminated"));
    this.prompt?.abort(new CancellationError("Terminated"));
  };

  get signal(): AbortSignal | undefined {
    return this.active?.signal;
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    process.on("SIGINT", this.onSigint);
    process.on("SIGTERM", this.onSigterm);
  }

  dispose(): void {
    if (!this.installed) return;
    process.off("SIGINT", this.onSigint);
    process.off("SIGTERM", this.onSigterm);
    this.installed = false;
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active !== undefined) {
      throw new Error("A cancellable operation is already active");
    }
    const controller = new AbortController();
    this.active = controller;
    try {
      return await operation(controller.signal);
    } finally {
      if (this.active === controller) this.active = undefined;
      if (this.terminateAfterOperation) this.exitRequested = true;
    }
  }

  async ask(prompts: PromptService, question: string): Promise<string> {
    const controller = new AbortController();
    this.prompt = controller;
    try {
      return await prompts.ask(question, controller.signal);
    } finally {
      if (this.prompt === controller) this.prompt = undefined;
    }
  }
}

export async function runInteractive(
  options: InteractiveOptions,
): Promise<void> {
  let runtime = options.runtime;
  options.cancellation.install();
  showHeader(options.renderer, runtime);

  try {
    while (!options.cancellation.exitRequested) {
      let input: string;
      try {
        input = await options.cancellation.ask(options.prompts, "> ");
      } catch (error) {
        if (options.cancellation.exitRequested || isAbortError(error)) break;
        throw error;
      }
      const trimmed = input.trim();
      if (trimmed === "") continue;
      const command = parseInteractiveCommand(trimmed);
      if (command === undefined) {
        try {
          await options.cancellation.run(async (signal) => {
            await runtime.agent.run(trimmed, { signal });
          });
          options.renderer.line();
          runtime.session = runtime.agent.session;
        } catch (error) {
          if (isAbortError(error)) {
            options.renderer.line("Cancelled.");
          } else {
            options.renderer.error(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        continue;
      }

      try {
        switch (command.name) {
          case "help":
            options.renderer.line(INTERACTIVE_HELP);
            break;
          case "login":
            runtime = await options.cancellation.run(options.login);
            showHeader(options.renderer, runtime);
            break;
          case "logout": {
            const removed = await options.logout(runtime.providerId);
            options.renderer.line(
              removed
                ? `Logged out from ${runtime.providerId}.`
                : `No stored credential for ${runtime.providerId}.`,
            );
            break;
          }
          case "model":
            if (command.model === undefined) {
              await showModels(options.renderer, runtime);
            } else {
              runtime.loop.setModel(command.model);
              await runtime.sessions.setModel(
                runtime.session.id,
                command.model,
              );
              await options.saveModel(runtime.providerId, command.model);
              runtime.model = command.model;
              runtime.session = await runtime.agent.refresh();
              options.renderer.line(`Model: ${command.model}`);
            }
            break;
          case "new":
            runtime = await options.newSession(runtime);
            showHeader(options.renderer, runtime);
            break;
          case "resume":
            if (command.sessionId === undefined) {
              await showSessions(options.renderer, runtime.sessions);
              options.renderer.line("Use /resume <session-id> to resume.");
            } else {
              runtime = await options.resume(command.sessionId);
              showHeader(options.renderer, runtime);
            }
            break;
          case "sessions":
            await showSessions(options.renderer, runtime.sessions);
            break;
          case "music":
            options.renderer.line(
              "Music controls require full-screen TUI mode.",
            );
            break;
          case "compact":
            {
              const previousSummary = runtime.agent.session.contextSummary;
              const previousCount = runtime.agent.session.compactedMessageCount;
              await options.cancellation.run(async (signal) => {
                await runtime.agent.compact({ signal });
              });
              runtime.session = runtime.agent.session;
              const contextChanged =
                runtime.session.compactedMessageCount > previousCount ||
                runtime.session.contextSummary !== previousSummary;
              options.renderer.line(
                contextChanged
                  ? "Context compacted."
                  : "No older context is eligible for compaction.",
              );
            }
            break;
          case "status":
            showStatus(options.renderer, runtime);
            break;
          case "clear":
            options.renderer.clear();
            break;
          case "exit":
            options.cancellation.exitRequested = true;
            break;
          case "unknown":
            options.renderer.line(
              command.reason ??
                `Unknown command: ${command.input}. Type /help.`,
            );
            break;
        }
      } catch (error) {
        if (isAbortError(error)) options.renderer.line("Cancelled.");
        else
          options.renderer.error(
            error instanceof Error ? error.message : String(error),
          );
      }
    }
  } finally {
    await runtime.sessions.flush();
    options.cancellation.dispose();
  }
}

function showHeader(
  renderer: TerminalRenderer,
  runtime: InteractiveRuntime,
): void {
  renderer.header({
    provider: runtime.providerId,
    model: runtime.model,
    cwd: runtime.cwd,
    sessionId: runtime.session.id,
  });
}

async function showModels(
  renderer: TerminalRenderer,
  runtime: InteractiveRuntime,
): Promise<void> {
  const models = await runtime.provider.listModels();
  if (models.length === 0) {
    renderer.line("No models returned by the active provider.");
    return;
  }
  for (const model of models) {
    renderer.line(
      `${model.id === runtime.model ? "*" : " "} ${model.id}${model.name ? ` - ${model.name}` : ""}`,
    );
  }
}

async function showSessions(
  renderer: TerminalRenderer,
  sessions: SessionService,
): Promise<void> {
  const states = await sessions.list();
  if (states.length === 0) {
    renderer.line("No saved sessions.");
    return;
  }
  for (const state of states) {
    renderer.line(
      `${state.id}  ${state.status.padEnd(9)}  ${state.provider}  ${state.model}  ${new Date(state.updatedAt).toISOString()}`,
    );
  }
}

function showStatus(
  renderer: TerminalRenderer,
  runtime: InteractiveRuntime,
): void {
  const state = runtime.agent.session;
  renderer.line(`provider: ${runtime.providerId}`);
  renderer.line(`model: ${runtime.model}`);
  renderer.line(`cwd: ${runtime.cwd}`);
  renderer.line(`session: ${state.id} (${state.status})`);
  renderer.line(`usage: ${renderer.renderUsage(state.usage)}`);
  renderer.line(
    `context: ${state.messages.length - state.compactedMessageCount} messages, ${JSON.stringify(state.messages.slice(state.compactedMessageCount)).length} chars`,
  );
}
