import { Box } from "ink";

import type { TuiLayout } from "./constraints.js";
import type { TuiState } from "../types.js";
import { CompanionPanel } from "../panels/companion-panel.js";
import { colors } from "../theme/colors.js";

export function BottomDock({
  state,
  layout,
}: {
  state: TuiState;
  layout: TuiLayout;
}): React.JSX.Element {
  return (
    <Box
      width={layout.dock.width}
      height={layout.dock.height}
      backgroundColor={colors.background}
      flexShrink={0}
      overflow="hidden"
    >
      <CompanionPanel
        state={state.companion}
        version={state.version}
        width={layout.dock.width}
        height={layout.dock.height}
        mode={layout.mode}
        frame={state.frame}
      />
    </Box>
  );
}
