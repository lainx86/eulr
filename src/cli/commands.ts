export type InteractiveCommand =
  | { name: "help" }
  | { name: "login" }
  | { name: "logout" }
  | { name: "model"; model?: string }
  | { name: "new" }
  | { name: "resume"; sessionId?: string }
  | { name: "sessions" }
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
    default:
      return { name: "unknown", input: trimmed };
  }
}

const HELP_USAGE_WIDTH = Math.max(
  ...INTERACTIVE_COMMANDS.map((definition) => definition.usage.length),
);

export const INTERACTIVE_HELP = INTERACTIVE_COMMANDS.map(
  ({ usage, description }) =>
    `${usage.padEnd(HELP_USAGE_WIDTH + 3)}${description}`,
).join("\n");
