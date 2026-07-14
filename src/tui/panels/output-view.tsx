import { Box, Text } from "ink";

import type { OutputViewState } from "../types.js";
import { colors } from "../theme/colors.js";
import { viewportLines } from "./view-utils.js";

export function OutputView({
  output,
  width,
  height,
  vertical,
  horizontal,
}: {
  output?: OutputViewState;
  width: number;
  height: number;
  vertical: number;
  horizontal: number;
}): React.JSX.Element {
  if (output === undefined)
    return <Text color={colors.muted}>No command output yet.</Text>;
  const lines = [
    ...output.stdout.split("\n").map((line) => ({ stream: "stdout", line })),
    ...output.stderr.split("\n").map((line) => ({ stream: "stderr", line })),
  ];
  const visible = viewportLines(
    lines.map(({ line }) => line),
    height - 2,
    vertical,
    width - 1,
    horizontal,
  );
  const source = lines.slice(
    Math.min(vertical, Math.max(0, lines.length - (height - 2))),
  );
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text color={colors.accent} wrap="truncate-middle">
        $ {output.command}
      </Text>
      <Text
        color={
          output.running
            ? colors.warning
            : output.exitCode === 0
              ? colors.success
              : colors.danger
        }
      >
        {output.running ? "running" : `exit ${output.exitCode ?? "unknown"}`}
        {output.truncated ? " · output truncated" : ""}
      </Text>
      {visible.map((line, index) => (
        <Text
          key={`${vertical + index}-${line}`}
          color={
            source[index]?.stream === "stderr"
              ? colors.danger
              : colors.foreground
          }
          wrap="truncate-end"
        >
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}
