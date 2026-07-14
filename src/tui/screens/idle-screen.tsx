import { Box, Text } from "ink";

import type { TuiState } from "../types.js";
import { colors } from "../theme/colors.js";
import { WelcomePanel } from "../panels/welcome-panel.js";

export function IdleScreen({
  state,
  width,
  height,
}: {
  state: TuiState;
  width: number;
  height: number;
}): React.JSX.Element {
  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      backgroundColor={colors.background}
      overflow="hidden"
    >
      <WelcomePanel
        state={state}
        width={width}
        height={Math.max(1, height - 1)}
      />
      <Box
        height={1}
        paddingX={2}
        justifyContent="center"
        backgroundColor={colors.background}
        flexShrink={0}
      >
        <Text
          color={
            state.phase === "failed"
              ? colors.danger
              : state.phase === "completed"
                ? colors.success
                : colors.muted
          }
          wrap="truncate-end"
        >
          ● {state.statusMessage}
        </Text>
      </Box>
    </Box>
  );
}
