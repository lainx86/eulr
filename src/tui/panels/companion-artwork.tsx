import { Box, Text } from "ink";

import type { CompanionState } from "../types.js";
import { colors } from "../theme/colors.js";

/**
 * Ink has no stable inline-image primitive, so the production renderer keeps a
 * neutral identity mark. Asset slots are intentionally isolated here for a
 * future terminal-protocol adapter without coupling image escape codes to layout.
 */
export function CompanionArtwork({
  state,
  frame,
  width,
}: {
  state: CompanionState;
  frame: number;
  width: number;
}): React.JSX.Element {
  const animated = isAnimated(state)
    ? (["✦", "·", "✧", "·"][frame % 4] ?? "✦")
    : state === "completed"
      ? "✓"
      : state === "error"
        ? "!"
        : state === "cancelled"
          ? "·"
          : "✦";
  return (
    <Box width={width} justifyContent="center">
      <Text color={state === "error" ? colors.danger : colors.accent} bold>
        eulr {animated}
      </Text>
    </Box>
  );
}

function isAnimated(state: CompanionState): boolean {
  return [
    "thinking",
    "reading",
    "editing",
    "running",
    "waiting_permission",
  ].includes(state);
}
