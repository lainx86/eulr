import { ConfigurationError } from "../utils/errors.js";

export type CliCommand =
  "run" | "auth-login" | "auth-logout" | "auth-status" | "models" | "sessions";

export interface CliArgs {
  command: CliCommand;
  task?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  resume?: string;
  yes: boolean;
  debug: boolean;
  plain: boolean;
  tui: boolean;
  help: boolean;
  version: boolean;
  device: boolean;
}

const valueOptions = new Set(["--cwd", "--provider", "--model", "--resume"]);

export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    command: "run",
    yes: false,
    debug: false,
    plain: false,
    tui: false,
    help: false,
    version: false,
    device: false,
  };

  const positionals: string[] = [];
  let index = 0;
  let parseOptions = true;
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === undefined) break;
    if (argument === "--") {
      parseOptions = false;
      index += 1;
      continue;
    }
    if (parseOptions && valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new ConfigurationError(`${argument} requires a value.`);
      }
      if (argument === "--cwd") result.cwd = value;
      if (argument === "--provider") result.provider = value;
      if (argument === "--model") result.model = value;
      if (argument === "--resume") result.resume = value;
      index += 2;
      continue;
    }
    if (parseOptions && argument.startsWith("--")) {
      if (argument === "--yes") result.yes = true;
      else if (argument === "--debug") result.debug = true;
      else if (argument === "--plain") result.plain = true;
      else if (argument === "--tui") result.tui = true;
      else if (argument === "--help") result.help = true;
      else if (argument === "--version") result.version = true;
      else if (argument === "--device") result.device = true;
      else throw new ConfigurationError(`Unknown option: ${argument}`);
      index += 1;
      continue;
    }
    positionals.push(argument);
    index += 1;
  }

  if (positionals[0] === "auth") {
    const action = positionals[1];
    if (positionals.length > 2) {
      throw new ConfigurationError("Unexpected arguments after auth command.");
    }
    if (action === "login") result.command = "auth-login";
    else if (action === "logout") result.command = "auth-logout";
    else if (action === "status") result.command = "auth-status";
    else if (!action && result.help) result.command = "auth-login";
    else {
      throw new ConfigurationError(
        "Use `eulr auth login`, `logout`, or `status`.",
      );
    }
  } else if (positionals[0] === "models") {
    if (positionals.length > 1)
      throw new ConfigurationError("Unexpected models arguments.");
    result.command = "models";
  } else if (positionals[0] === "sessions") {
    if (positionals.length > 1)
      throw new ConfigurationError("Unexpected sessions arguments.");
    result.command = "sessions";
  } else if (positionals.length > 0) {
    result.task = positionals.join(" ");
  }

  if (result.device && result.command !== "auth-login") {
    throw new ConfigurationError(
      "--device is only valid with `eulr auth login`.",
    );
  }
  if (result.resume && result.task) {
    throw new ConfigurationError(
      "--resume cannot be combined with a one-shot task.",
    );
  }
  if (result.plain && result.tui) {
    throw new ConfigurationError("--plain and --tui cannot be combined.");
  }
  return result;
}

export const HELP_TEXT = `eulr - minimal terminal AI coding agent

Usage:
  eulr [options]
  eulr [options] "<task>"
  eulr auth login [--device]
  eulr auth logout
  eulr auth status
  eulr models
  eulr sessions

Options:
  --cwd <path>           Set the working directory
  --provider <id>        Select openai-codex or openai-compatible
  --model <id>           Select a model
  --resume <session-id>  Resume an existing session
  --yes                  Approve normal writes and commands
  --plain                Use the plain terminal renderer
  --tui                  Require the full-screen terminal UI
  --debug                Show sanitized technical diagnostics
  --help                 Show this help
  --version              Show the version
`;
