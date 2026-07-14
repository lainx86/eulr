import type { AgentEvent, AgentEventSink } from "../agent/events.js";
import type { TokenUsage } from "../agent/messages.js";
import { redactText } from "../auth/redaction.js";

const color = {
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  gray: "\u001b[90m",
  reset: "\u001b[0m",
};

export interface HeaderInfo {
  provider: string;
  model: string;
  cwd: string;
  sessionId: string;
}

export class TerminalRenderer {
  readonly useColor: boolean;
  private thinkingShown = false;

  constructor(
    private readonly output: NodeJS.WriteStream = process.stdout,
    private readonly errorOutput: NodeJS.WriteStream = process.stderr,
    private readonly debugEnabled = false,
  ) {
    this.useColor = Boolean(output.isTTY && !process.env.NO_COLOR);
  }

  header(info: HeaderInfo): void {
    this.output.write(
      `eulr\nprovider: ${info.provider}\nmodel: ${info.model}\ncwd: ${info.cwd}\nsession: ${info.sessionId}\n\nType /help for commands.\n\n`,
    );
  }

  line(text = ""): void {
    this.output.write(`${text}\n`);
  }

  clear(): void {
    if (this.output.isTTY) {
      this.output.write("\u001b[2J\u001b[H");
    }
  }

  error(message: string): void {
    this.errorOutput.write(
      `${this.paint("red", "Error:")} ${redactText(message)}\n`,
    );
  }

  debug(value: unknown): void {
    if (!this.debugEnabled) return;
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    this.errorOutput.write(
      `${this.paint("gray", "debug:")} ${redactText(serialized)}\n`,
    );
  }

  eventSink(): AgentEventSink {
    return (event) => this.renderEvent(event);
  }

  renderUsage(usage: TokenUsage): string {
    return `${usage.inputTokens} input, ${usage.outputTokens} output, ${usage.cachedInputTokens} cached`;
  }

  private renderEvent(event: AgentEvent): void {
    switch (event.type) {
      case "task_started":
        this.thinkingShown = false;
        break;
      case "text_delta":
        this.output.write(event.text);
        break;
      case "thinking":
        if (!this.thinkingShown) {
          this.line(`${this.paint("cyan", "●")} Thinking`);
          this.thinkingShown = true;
        }
        break;
      case "project_instructions_loaded":
        this.line(
          `${this.paint("cyan", "●")} ${event.reloaded ? "Reloaded" : "Loaded"} ${event.path}`,
        );
        break;
      case "tool_started":
        this.thinkingShown = false;
        this.line(
          `${this.paint("cyan", "●")} ${toolVerb(event.toolName)} ${redactText(event.target)}`,
        );
        break;
      case "tool_output":
        if (this.debugEnabled) this.output.write(redactText(event.chunk));
        break;
      case "tool_finished":
        this.line(
          `${this.paint(event.isError ? "red" : "green", event.isError ? "✗" : "✓")} ${redactText(event.summary)}`,
        );
        break;
      case "usage":
        if (this.debugEnabled)
          this.debug(`usage ${this.renderUsage(event.usage)}`);
        break;
    }
  }

  private paint(name: keyof typeof color, text: string): string {
    return this.useColor ? `${color[name]}${text}${color.reset}` : text;
  }
}

function toolVerb(toolName: string): string {
  if (toolName === "read") return "Reading";
  if (toolName === "bash") return "Running";
  if (toolName === "edit") return "Editing";
  if (toolName === "write") return "Writing";
  return `Using ${toolName}`;
}
