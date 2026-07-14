import path from "node:path";

import { isSensitivePath } from "./permission-manager.js";

export type CommandRiskLevel = "normal" | "high";

export interface CommandRiskAssessment {
  level: CommandRiskLevel;
  reason?: string;
}

interface ParsedCommand {
  executable: string;
  arguments: string[];
}

const SHELL_EXECUTABLES = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n"]);
const WRAPPERS = new Set(["command", "doas", "nohup", "sudo"]);
const ENV_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-S",
  "-u",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);
const PRIVILEGE_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-g",
  "-h",
  "-p",
  "-u",
  "--chdir",
  "--close-from",
  "--group",
  "--host",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const SENSITIVE_FILE_READERS = new Set([
  ".",
  "base64",
  "cat",
  "cp",
  "head",
  "hexdump",
  "less",
  "more",
  "nl",
  "od",
  "scp",
  "source",
  "strings",
  "tail",
  "xxd",
]);
const MAX_NESTED_SHELL_DEPTH = 4;

function executableName(value: string): string {
  return path.basename(value).toLowerCase();
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  const flush = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";

    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/u.test(character)) {
      flush();
      if (character === "\n") {
        tokens.push("\n");
      }
      continue;
    }

    if (character === ";" || character === "|" || character === "&") {
      flush();
      const next = command[index + 1];
      if (next === character && (character === "|" || character === "&")) {
        tokens.push(character + next);
        index += 1;
      } else {
        tokens.push(character);
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }
  flush();
  return tokens;
}

function commandSegments(tokens: string[]): string[][] {
  const result: string[][] = [];
  let segment: string[] = [];

  for (const token of tokens) {
    if (COMMAND_SEPARATORS.has(token)) {
      if (segment.length > 0) {
        result.push(segment);
        segment = [];
      }
    } else {
      segment.push(token);
    }
  }

  if (segment.length > 0) {
    result.push(segment);
  }
  return result;
}

function unwrapCommand(tokens: string[]): ParsedCommand | undefined {
  let index = 0;

  while (
    index < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")
  ) {
    index += 1;
  }

  let executable = executableName(tokens[index] ?? "");
  index += 1;

  for (let unwraps = 0; unwraps < 16; unwraps += 1) {
    if (executable === "env") {
      while (index < tokens.length) {
        const token = tokens[index] ?? "";
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
          index += 1;
          continue;
        }
        if (token === "--") {
          index += 1;
          break;
        }
        if (!token.startsWith("-")) {
          break;
        }
        index += 1;
        if (ENV_OPTIONS_WITH_VALUES.has(token)) {
          index += 1;
        }
      }
      executable = executableName(tokens[index] ?? "");
      index += 1;
      continue;
    }

    if (WRAPPERS.has(executable)) {
      while (index < tokens.length) {
        const option = tokens[index] ?? "";
        if (option === "--") {
          index += 1;
          break;
        }
        if (!option.startsWith("-")) {
          break;
        }
        index += 1;
        if (
          (executable === "sudo" || executable === "doas") &&
          PRIVILEGE_OPTIONS_WITH_VALUES.has(option)
        ) {
          index += 1;
        }
      }
      executable = executableName(tokens[index] ?? "");
      index += 1;
      continue;
    }

    if (executable === "busybox") {
      const applet = tokens[index] ?? "";
      if (applet.length === 0 || applet.startsWith("-")) {
        break;
      }
      executable = executableName(applet);
      index += 1;
      continue;
    }

    break;
  }

  if (executable.length === 0) {
    return undefined;
  }
  return { executable, arguments: tokens.slice(index) };
}

function optionHasFlag(option: string, flag: string): boolean {
  return (
    option === `-${flag}` ||
    (option.startsWith("-") &&
      !option.startsWith("--") &&
      option.slice(1).includes(flag))
  );
}

function dangerousDeletionTarget(target: string): boolean {
  const home = process.env.HOME?.replaceAll(path.sep, "/");

  if (/^~[^/]+(?:\/|$)/u.test(target)) {
    return true;
  }

  if (
    home === undefined &&
    (target === "$HOME" ||
      target.startsWith("$HOME/") ||
      target === "${HOME}" ||
      target.startsWith("${HOME}/") ||
      target === "~" ||
      target.startsWith("~/"))
  ) {
    return true;
  }

  let expanded = target;
  if (home !== undefined) {
    if (expanded === "~" || expanded.startsWith("~/")) {
      expanded = `${home}${expanded.slice(1)}`;
    } else if (expanded === "$HOME" || expanded.startsWith("$HOME/")) {
      expanded = `${home}${expanded.slice("$HOME".length)}`;
    } else if (expanded === "${HOME}" || expanded.startsWith("${HOME}/")) {
      expanded = `${home}${expanded.slice("${HOME}".length)}`;
    }
  }

  const normalized = path.posix.normalize(expanded);
  const normalizedHome =
    home === undefined ? undefined : path.posix.normalize(home);
  return (
    normalized === "/" ||
    normalized === "/*" ||
    normalized === "/home" ||
    normalized === "/home/*" ||
    normalized === "/Users" ||
    normalized === "/Users/*" ||
    (normalizedHome !== undefined &&
      (normalized === normalizedHome ||
        normalized.startsWith(`${normalizedHome}/`)))
  );
}

function assessRm(arguments_: string[]): CommandRiskAssessment | undefined {
  let recursive = false;
  const targets: string[] = [];
  let optionsEnded = false;

  for (const argument of arguments_) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && argument.startsWith("-")) {
      recursive ||=
        argument === "--recursive" ||
        optionHasFlag(argument, "r") ||
        optionHasFlag(argument, "R");
      if (argument === "--no-preserve-root") {
        return { level: "high", reason: "rm disables root preservation" };
      }
    } else {
      targets.push(argument);
    }
  }

  if (recursive && targets.some(dangerousDeletionTarget)) {
    return {
      level: "high",
      reason:
        "recursive deletion targets the filesystem root or home directory",
    };
  }
  return undefined;
}

function isRawDiskPath(value: string): boolean {
  const normalized = path.posix.normalize(value.replace(/^of=/u, ""));
  return /^\/dev\/(?:disk\/.+|mapper\/.+|(?:disk|dm-|hd|loop|md|mmcblk|nvme|rbd|rdisk|sd|vd|xvd)[A-Za-z0-9._-]*)$/u.test(
    normalized,
  );
}

function redirectionTargets(command: string, operator: "<" | ">"): string[] {
  const targets: string[] = [];
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";

    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character !== operator) {
      continue;
    }

    if (operator === "<" && command[index + 1] === "<") {
      while (command[index + 1] === "<") {
        index += 1;
      }
      continue;
    }

    if (
      operator === ">" &&
      (command[index + 1] === ">" || command[index + 1] === "|")
    ) {
      index += 1;
    }

    let cursor = index + 1;
    while (/\s/u.test(command[cursor] ?? "")) {
      cursor += 1;
    }

    let target = "";
    let targetQuote: "'" | '"' | undefined;
    for (; cursor < command.length; cursor += 1) {
      const targetCharacter = command[cursor] ?? "";
      if (targetCharacter === "\\" && targetQuote !== "'") {
        cursor += 1;
        target += command[cursor] ?? "";
        continue;
      }
      if (targetQuote !== undefined) {
        if (targetCharacter === targetQuote) {
          targetQuote = undefined;
        } else {
          target += targetCharacter;
        }
        continue;
      }
      if (targetCharacter === "'" || targetCharacter === '"') {
        targetQuote = targetCharacter;
        continue;
      }
      if (/\s/u.test(targetCharacter) || /[;&|<>]/u.test(targetCharacter)) {
        break;
      }
      target += targetCharacter;
    }

    if (target.length > 0) {
      targets.push(target);
    }
    index = Math.max(index, cursor - 1);
  }

  return targets;
}

function sensitivePathArgument(argument: string): boolean {
  if (isSensitivePath(argument)) {
    return true;
  }
  const assignment = argument.indexOf("=");
  return assignment >= 0 && isSensitivePath(argument.slice(assignment + 1));
}

function includesForceOption(arguments_: string[]): boolean {
  return arguments_.some(
    (argument) =>
      argument === "-f" ||
      optionHasFlag(argument, "f") ||
      argument === "--force" ||
      argument.startsWith("--force="),
  );
}

function assessParsedCommand(
  command: ParsedCommand,
  depth: number,
): CommandRiskAssessment | undefined {
  const { executable, arguments: arguments_ } = command;

  if (executable === "rm") {
    return assessRm(arguments_);
  }

  if (/^mkfs(?:\..+)?$/u.test(executable) || executable === "mkswap") {
    return { level: "high", reason: "command formats a filesystem" };
  }

  if (
    executable === "wipefs" ||
    (executable === "dd" && arguments_.some(isRawDiskPath)) ||
    (["cp", "shred", "tee"].includes(executable) &&
      arguments_.some(isRawDiskPath))
  ) {
    return { level: "high", reason: "command can overwrite a raw disk device" };
  }

  if (
    SENSITIVE_FILE_READERS.has(executable) &&
    arguments_.some(sensitivePathArgument)
  ) {
    return {
      level: "high",
      reason: "command may read a file containing credentials or secrets",
    };
  }

  if (["halt", "poweroff", "reboot", "shutdown"].includes(executable)) {
    return {
      level: "high",
      reason: "command powers off or restarts the system",
    };
  }

  if (
    executable === "systemctl" &&
    arguments_.some((argument) =>
      ["halt", "poweroff", "reboot"].includes(argument),
    )
  ) {
    return {
      level: "high",
      reason: "command powers off or restarts the system",
    };
  }

  if (executable === "git") {
    const resetIndex = arguments_.indexOf("reset");
    if (
      resetIndex >= 0 &&
      arguments_.slice(resetIndex + 1).includes("--hard")
    ) {
      return {
        level: "high",
        reason: "git reset --hard discards working tree changes",
      };
    }

    const cleanIndex = arguments_.indexOf("clean");
    if (
      cleanIndex >= 0 &&
      includesForceOption(arguments_.slice(cleanIndex + 1))
    ) {
      return {
        level: "high",
        reason: "git clean with force deletes untracked files",
      };
    }

    const pushIndex = arguments_.indexOf("push");
    const pushArguments = pushIndex >= 0 ? arguments_.slice(pushIndex + 1) : [];
    if (
      pushIndex >= 0 &&
      pushArguments.some(
        (argument) =>
          (argument.startsWith("+") && argument.length > 1) ||
          optionHasFlag(argument, "f") ||
          ["--force", "--force-with-lease", "--force-if-includes"].includes(
            argument,
          ) ||
          argument.startsWith("--force-with-lease=") ||
          argument.startsWith("--force-if-includes="),
      )
    ) {
      return {
        level: "high",
        reason: "force push can overwrite remote history",
      };
    }
  }

  if (depth < MAX_NESTED_SHELL_DEPTH && SHELL_EXECUTABLES.has(executable)) {
    const commandIndex = arguments_.findIndex(
      (argument) => argument === "--command" || optionHasFlag(argument, "c"),
    );
    const nested = commandIndex >= 0 ? arguments_[commandIndex + 1] : undefined;
    if (nested !== undefined) {
      const nestedAssessment = analyzeCommandRisk(nested, depth + 1);
      if (nestedAssessment.level === "high") {
        return nestedAssessment;
      }
    }
  }

  return undefined;
}

export function analyzeCommandRisk(
  command: string,
  depth = 0,
): CommandRiskAssessment {
  // A fork bomb is shell syntax rather than a conventional executable/argv pair.
  if (
    /^\s*:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*;?\s*\}\s*;\s*:\s*;?\s*$/u.test(
      command,
    )
  ) {
    return { level: "high", reason: "command is a fork bomb" };
  }

  if (redirectionTargets(command, ">").some(isRawDiskPath)) {
    return {
      level: "high",
      reason: "output redirection can overwrite a raw disk device",
    };
  }

  if (redirectionTargets(command, "<").some(isSensitivePath)) {
    return {
      level: "high",
      reason: "command may read a file containing credentials or secrets",
    };
  }

  for (const segment of commandSegments(tokenize(command))) {
    const parsed = unwrapCommand(segment);
    if (parsed === undefined) {
      continue;
    }
    const assessment = assessParsedCommand(parsed, depth);
    if (assessment !== undefined) {
      return assessment;
    }
  }

  return { level: "normal" };
}

export function isHighRiskCommand(command: string): boolean {
  return analyzeCommandRisk(command).level === "high";
}
