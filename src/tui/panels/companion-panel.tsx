import { Box, Text } from "ink";

import type { CompanionState } from "../types.js";
import type { LayoutMode } from "../layout/constraints.js";
import { colors } from "../theme/colors.js";
import { CompanionArtwork } from "./companion-artwork.js";
import { PanelFrame } from "./panel-frame.js";

const MESSAGES: Record<CompanionState, string> = {
  idle: "I'm here to help.",
  thinking: "Thinking through the task.",
  reading: "Understanding the codebase.",
  editing: "Focused on writing code.",
  running: "Checking the result.",
  waiting_permission: "Need your approval.",
  completed: "Task completed.",
  error: "Something needs attention.",
  cancelled: "Task interrupted.",
};

export function CompanionPanel({
  state,
  version,
  width,
  height,
  mode,
  frame,
}: {
  state: CompanionState;
  version: string;
  width: number;
  height: number;
  mode: LayoutMode;
  frame: number;
}): React.JSX.Element {
  return (
    <PanelFrame
      title="EULR COMPANION"
      height={height}
      width={width}
      accent={colors.companion}
    >
      {mode === "minimum" ? (
        <Text wrap="truncate-end" color={stateColor(state)}>
          eulr ✦ · {shortState(state)}
        </Text>
      ) : (
        <Box
          columnGap={2}
          height={Math.max(1, height - 3)}
          alignItems="center"
          overflow="hidden"
        >
          <CompanionArtwork
            state={state}
            frame={frame}
            width={mode === "full" ? 9 : 6}
          />
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            <Text color={stateColor(state)} bold wrap="truncate-end">
              {shortState(state)}
            </Text>
            <Text color={colors.foreground} wrap="truncate-end">
              {MESSAGES[state]}
            </Text>
            {mode === "full" && (
              <Text color={colors.muted} wrap="truncate-end">
                v{version} · {companionDetail(state)}
              </Text>
            )}
          </Box>
        </Box>
      )}
    </PanelFrame>
  );
}

function shortState(state: CompanionState): string {
  return state.replace("_", " ");
}

function stateColor(state: CompanionState): string {
  if (state === "error") return colors.danger;
  if (state === "completed") return colors.success;
  if (state === "waiting_permission") return colors.warning;
  if (state === "cancelled") return colors.muted;
  return colors.accent;
}

function companionDetail(state: CompanionState): string {
  if (state === "idle") return "ready when you are";
  if (state === "completed") return "ready for the next task";
  if (state === "waiting_permission") return "waiting for approval";
  return state.replace("_", " ");
}
