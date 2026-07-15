import { redactText } from "../auth/redaction.js";

const TAB_WIDTH = 4;

/** Normalizes untrusted text before it reaches Ink's terminal renderer. */
export function displayText(value: string): string {
  const normalized = redactText(value)
    .replace(/\r\n?|\u2028|\u2029/gu, "\n")
    // Keep newlines, but remove controls that can reposition the terminal.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
  return normalized
    .split("\n")
    .map((line) => expandTabs(line))
    .join("\n");
}

export function displayLine(value: string): string {
  return displayText(value).replace(/\n+/gu, " ↵ ");
}

export function displayOptionalLine(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : displayLine(value);
}

function expandTabs(value: string): string {
  let result = "";
  let column = 0;
  for (const character of value) {
    if (character === "\t") {
      const spaces = TAB_WIDTH - (column % TAB_WIDTH);
      result += " ".repeat(spaces);
      column += spaces;
    } else {
      result += character;
      column += 1;
    }
  }
  return result;
}
