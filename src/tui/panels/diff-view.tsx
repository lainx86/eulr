import { Box, Text } from "ink";

import type { FileChangeState } from "../types.js";
import { colors } from "../theme/colors.js";
import { buildDiffLines } from "./view-utils.js";

export function DiffView({
  change,
  width,
  height,
  vertical,
  horizontal,
}: {
  change?: FileChangeState;
  width: number;
  height: number;
  vertical: number;
  horizontal: number;
}): React.JSX.Element {
  if (change === undefined)
    return <Text color={colors.muted}>No file changes yet.</Text>;
  const diff = buildDiffLines(change.before, change.after);
  const bodyHeight = Math.max(0, height - 1);
  const start = Math.min(
    Math.max(0, vertical),
    Math.max(0, diff.length - bodyHeight),
  );
  const lineWidth = Math.max(3, String(Math.max(1, diff.length)).length);
  const contentWidth = Math.max(1, width - lineWidth * 2 - 7);
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text color={colors.accent} wrap="truncate-middle">
        {change.before === null ? "new file · " : "modified · "}
        {change.path}
        {change.truncated ? " · preview truncated" : ""}
      </Text>
      {diff.slice(start, start + bodyHeight).map((line, index) => {
        const marker =
          line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
        const color =
          line.kind === "added"
            ? colors.success
            : line.kind === "removed"
              ? colors.danger
              : colors.foreground;
        return (
          <Text
            key={`${start + index}-${line.kind}-${line.text}`}
            color={color}
            wrap="truncate-end"
          >
            {String(line.oldLine ?? "").padStart(lineWidth)}{" "}
            {String(line.newLine ?? "").padStart(lineWidth)} {marker}{" "}
            {line.text.slice(horizontal, horizontal + contentWidth)}
          </Text>
        );
      })}
    </Box>
  );
}
