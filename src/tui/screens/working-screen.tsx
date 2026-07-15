import { Box, Text } from "ink";

import type { LayoutMode } from "../layout/constraints.js";
import type { TuiState } from "../types.js";
import { colors } from "../theme/colors.js";
import { ActivityPanel } from "../panels/activity-panel.js";
import { InspectorPanel } from "../panels/inspector-panel.js";

export function WorkingScreen({
  state,
  width,
  height,
  mode,
}: {
  state: TuiState;
  width: number;
  height: number;
  mode: LayoutMode;
}): React.JSX.Element {
  if (mode === "minimum") {
    const showInspector =
      state.focus === "inspector" || state.phase === "completed";
    return (
      <Box
        width={width}
        height={height}
        flexDirection="column"
        backgroundColor={colors.background}
        overflow="hidden"
      >
        <Text color={colors.warning} wrap="truncate-end">
          Compact terminal · Tab changes the visible panel
        </Text>
        {showInspector ? (
          <InspectorPanel
            inspector={state.inspector}
            scroll={state.scroll.inspector}
            width={width}
            height={Math.max(1, height - 1)}
            active
          />
        ) : (
          <ActivityPanel
            task={state.task}
            activities={state.activities}
            width={width}
            height={Math.max(1, height - 1)}
            offset={state.scroll.activity}
            active={state.focus === "activity"}
            frame={state.frame}
          />
        )}
      </Box>
    );
  }

  const gap = 1;
  const activityWidth = Math.max(
    30,
    Math.floor((width - gap) * (mode === "full" ? 0.42 : 0.38)),
  );
  const inspectorWidth = Math.max(30, width - gap - activityWidth);
  return (
    <Box
      width={width}
      height={height}
      columnGap={gap}
      backgroundColor={colors.background}
      flexShrink={0}
      overflow="hidden"
    >
      <ActivityPanel
        task={state.task}
        activities={state.activities}
        width={activityWidth}
        height={height}
        offset={state.scroll.activity}
        active={state.focus === "activity"}
        frame={state.frame}
      />
      <InspectorPanel
        inspector={state.inspector}
        scroll={state.scroll.inspector}
        width={inspectorWidth}
        height={height}
        active={state.focus === "inspector"}
      />
    </Box>
  );
}
