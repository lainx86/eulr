import type { MusicCommand } from "../music/types.js";

export type InteractiveCommand =
  | { name: "help" }
  | { name: "login" }
  | { name: "logout" }
  | { name: "model"; model?: string }
  | { name: "new" }
  | { name: "resume"; sessionId?: string }
  | { name: "sessions" }
  | { name: "music"; command: MusicCommand }
  | { name: "compact" }
  | { name: "status" }
  | { name: "clear" }
  | { name: "exit" }
  | { name: "unknown"; input: string; reason?: string };

export interface InteractiveCommandDefinition {
  readonly command: `/${string}`;
  readonly usage: string;
  readonly description: string;
  readonly completion: string;
}

export const INTERACTIVE_COMMANDS: readonly InteractiveCommandDefinition[] = [
  {
    command: "/help",
    usage: "/help",
    description: "Show interactive commands",
    completion: "/help",
  },
  {
    command: "/login",
    usage: "/login",
    description: "Authenticate a provider",
    completion: "/login",
  },
  {
    command: "/logout",
    usage: "/logout",
    description: "Remove the active provider credential",
    completion: "/logout",
  },
  {
    command: "/model",
    usage: "/model [model-id]",
    description: "Select the model and reasoning level",
    completion: "/model ",
  },
  {
    command: "/new",
    usage: "/new",
    description: "Start a new session",
    completion: "/new",
  },
  {
    command: "/resume",
    usage: "/resume [session-id]",
    description: "Resume a session or choose one",
    completion: "/resume ",
  },
  {
    command: "/sessions",
    usage: "/sessions",
    description: "List recent sessions",
    completion: "/sessions",
  },
  {
    command: "/music",
    usage: "/music <command>",
    description: "Control local music playback",
    completion: "/music ",
  },
  {
    command: "/compact",
    usage: "/compact",
    description: "Compact older context",
    completion: "/compact",
  },
  {
    command: "/status",
    usage: "/status",
    description: "Show provider, model, cwd, session, and usage",
    completion: "/status",
  },
  {
    command: "/clear",
    usage: "/clear",
    description: "Clear the terminal without deleting history",
    completion: "/clear",
  },
  {
    command: "/exit",
    usage: "/exit",
    description: "Save and exit",
    completion: "/exit",
  },
] as const;

export function parseInteractiveCommand(
  input: string,
): InteractiveCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/u);
  const argument = rest.join(" ").trim();
  switch (rawName) {
    case "help":
    case "login":
    case "logout":
    case "new":
    case "sessions":
    case "compact":
    case "status":
    case "clear":
    case "exit":
      return { name: rawName };
    case "model":
      return argument ? { name: "model", model: argument } : { name: "model" };
    case "resume":
      return argument
        ? { name: "resume", sessionId: argument }
        : { name: "resume" };
    case "music":
      return parseMusicCommand(argument, trimmed);
    default:
      return { name: "unknown", input: trimmed };
  }
}

function parseMusicCommand(
  argument: string,
  input: string,
): InteractiveCommand {
  const separator = argument.search(/\s/u);
  const subcommand = separator < 0 ? argument : argument.slice(0, separator);
  const value = separator < 0 ? "" : argument.slice(separator).trim();

  switch (subcommand) {
    case "library":
      return value
        ? { name: "music", command: { type: "library", path: value } }
        : invalidMusic(input, "Usage: /music library <path>");
    case "play":
    case "builtin":
    case "pause":
    case "toggle":
    case "next":
    case "previous":
    case "shuffle":
    case "repeat":
    case "status":
      return value
        ? invalidMusic(
            input,
            `/music ${subcommand} does not accept an argument.`,
          )
        : { name: "music", command: { type: subcommand } };
    case "seek": {
      const seconds = parseFiniteNumber(value);
      return seconds !== undefined && seconds >= 0
        ? { name: "music", command: { type: "seek", seconds } }
        : invalidMusic(input, "Usage: /music seek <nonnegative-seconds>");
    }
    case "volume": {
      const volume = parseFiniteNumber(value);
      return volume !== undefined && volume >= 0 && volume <= 100
        ? { name: "music", command: { type: "volume", volume } }
        : invalidMusic(input, "Usage: /music volume <0-100>");
    }
    default:
      return invalidMusic(
        input,
        "Use /music builtin, library, play, pause, toggle, next, previous, seek, volume, shuffle, repeat, or status.",
      );
  }
}

function parseFiniteNumber(value: string): number | undefined {
  if (value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function invalidMusic(input: string, reason: string): InteractiveCommand {
  return { name: "unknown", input, reason };
}

const HELP_USAGE_WIDTH = Math.max(
  ...INTERACTIVE_COMMANDS.map((definition) => definition.usage.length),
);

export const INTERACTIVE_HELP = INTERACTIVE_COMMANDS.map(
  ({ usage, description }) =>
    `${usage.padEnd(HELP_USAGE_WIDTH + 3)}${description}`,
).join("\n");
