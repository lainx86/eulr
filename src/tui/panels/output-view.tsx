import { Box, Text } from "ink";

import type { OutputViewState } from "../types.js";
import { colors } from "../theme/colors.js";
import { displayLine } from "../display-text.js";
import { viewportSlice } from "./view-utils.js";

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
  const viewport = viewportSlice(lines, height - 2, vertical);
  const contentWidth = Math.max(0, width - 1);
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
      {viewport.items.map((item, index) => {
        const line = displayLine(item.line).slice(
          Math.max(0, horizontal),
          Math.max(0, horizontal) + contentWidth,
        );
        return (
          <Text
            key={`${viewport.start + index}-${item.stream}`}
            color={item.stream === "stderr" ? colors.danger : colors.foreground}
            wrap="truncate-end"
          >
            {line || " "}
          </Text>
        );
      })}
    </Box>
  );
}
