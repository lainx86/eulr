import { diffLines } from "diff";

export interface DiffDisplayLine {
  kind: "context" | "added" | "removed";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export function buildDiffLines(
  before: string | null,
  after: string,
): DiffDisplayLine[] {
  const result: DiffDisplayLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffLines(before ?? "", after)) {
    const lines = trimDiffTerminator(part.value.split("\n"));
    for (const text of lines) {
      if (part.added) {
        result.push({ kind: "added", newLine, text });
        newLine += 1;
      } else if (part.removed) {
        result.push({ kind: "removed", oldLine, text });
        oldLine += 1;
      } else {
        result.push({ kind: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return result;
}

export function viewportLines(
  lines: readonly string[],
  height: number,
  vertical: number,
  width: number,
  horizontal = 0,
): string[] {
  const safeHeight = Math.max(0, Math.floor(height));
  const safeWidth = Math.max(0, Math.floor(width));
  const maxStart = Math.max(0, lines.length - safeHeight);
  const start = Math.min(Math.max(0, Math.floor(vertical)), maxStart);
  return lines
    .slice(start, start + safeHeight)
    .map((line) => line.slice(Math.max(0, horizontal), horizontal + safeWidth));
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? Math.floor(seconds) : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function progressBar(value: number, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const filled = Math.round(safeWidth * clamped);
  return `${"━".repeat(filled)}${"─".repeat(safeWidth - filled)}`;
}

function trimDiffTerminator(lines: string[]): string[] {
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
