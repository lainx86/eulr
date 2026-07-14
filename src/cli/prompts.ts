import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import { CancellationError } from "../utils/errors.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../permissions/types.js";
import { redactText } from "../auth/redaction.js";

export interface PromptIO {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

export class PromptService {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;

  constructor(io: Partial<PromptIO> = {}) {
    this.input = io.input ?? process.stdin;
    this.output = io.output ?? process.stdout;
  }

  async ask(question: string, signal?: AbortSignal): Promise<string> {
    const readline = createInterface({
      input: this.input as Readable,
      output: this.output as Writable,
      terminal: Boolean(this.input.isTTY && this.output.isTTY),
    });
    try {
      return signal
        ? await readline.question(question, { signal })
        : await readline.question(question);
    } catch (error) {
      if (signal?.aborted) {
        throw new CancellationError("Input cancelled.", { cause: error });
      }
      throw error;
    } finally {
      readline.close();
    }
  }

  async chooseAuthentication(
    signal?: AbortSignal,
  ): Promise<"openai-codex" | "openai-compatible"> {
    this.output.write(
      "Choose authentication method:\n\n1. ChatGPT Plus/Pro\n2. OpenAI-compatible API\n\n",
    );
    const answer = (await this.ask("Select [1-2]: ", signal)).trim();
    if (answer === "1") return "openai-codex";
    if (answer === "2") return "openai-compatible";
    throw new CancellationError("Authentication selection cancelled.");
  }

  async confirmPermission(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    if (!this.input.isTTY || !this.output.isTTY) {
      return { allowed: false, remember: false };
    }

    if (request.category === "high-risk-execute" && request.risk) {
      this.output.write(`High-risk operation: ${request.risk}\n`);
    }
    const verb =
      request.category === "write"
        ? "edit"
        : request.category === "sensitive-read"
          ? "read a sensitive file"
          : "run";
    this.output.write(
      `eulr wants to ${verb}:\n${redactText(request.target)}\n\n`,
    );
    const choices =
      request.category === "high-risk-execute" ? "[y/N]" : "[y/N/a]";
    const answer = (await this.ask(`Allow? ${choices} `, signal))
      .trim()
      .toLowerCase();
    return {
      allowed: answer === "y" || answer === "yes" || answer === "a",
      remember: answer === "a" && request.category !== "high-risk-execute",
    };
  }

  async readSecret(label = "API key: ", signal?: AbortSignal): Promise<string> {
    if (!this.input.isTTY || !this.output.isTTY || !this.input.setRawMode) {
      throw new CancellationError(
        "Hidden credential input requires an interactive terminal.",
      );
    }

    this.output.write(label);
    const wasRaw = this.input.isRaw;
    this.input.setRawMode(true);
    this.input.resume();

    try {
      return await new Promise<string>((resolve, reject) => {
        let value = "";
        const cleanup = () => {
          this.input.off("data", onData);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(new CancellationError("Credential input cancelled."));
        };
        const onData = (chunk: Buffer | string) => {
          const text = chunk.toString();
          for (const character of text) {
            if (character === "\u0003") {
              cleanup();
              reject(new CancellationError("Credential input cancelled."));
              return;
            }
            if (character === "\r" || character === "\n") {
              cleanup();
              this.output.write("\n");
              resolve(value);
              return;
            }
            if (character === "\u007f" || character === "\b") {
              value = value.slice(0, -1);
            } else if (character >= " ") {
              value += character;
            }
          }
        };
        this.input.on("data", onData);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      this.input.setRawMode(Boolean(wasRaw));
      this.input.pause();
    }
  }
}
