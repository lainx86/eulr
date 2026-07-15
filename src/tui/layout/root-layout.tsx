import { Box, Text } from "ink";

import type { InputBufferSnapshot } from "../state/input-buffer.js";
import type { TuiLayout } from "./constraints.js";
import type { TuiState } from "../types.js";
import { colors } from "../theme/colors.js";
import { BottomDock } from "./bottom-dock.js";
import { InputArea } from "./input-area.js";
import { IdleScreen } from "../screens/idle-screen.js";
import { WorkingScreen } from "../screens/working-screen.js";
import { Overlay } from "../overlays/overlay.js";
import {
  CommandPalette,
  getSlashCommandSuggestions,
} from "../overlays/command-palette.js";

export function RootLayout({
  state,
  input,
  layout,
  commandPalette,
}: {
  state: TuiState;
  input: InputBufferSnapshot;
  layout: TuiLayout;
  commandPalette?: {
    visible: boolean;
    selectedIndex: number;
  };
}): React.JSX.Element {
  const headerHeight = layout.main.height >= 5 ? 2 : 0;
  const contentHeight = Math.max(0, layout.main.height - headerHeight);
  const working =
    state.phase !== "idle" ||
    state.activities.length > 0 ||
    state.task !== undefined;
  const fullHeader = layout.width >= 120;
  const commandSuggestions = commandPalette?.visible
    ? getSlashCommandSuggestions(input.value)
    : [];
  const commandPaletteHeight = Math.min(
    commandSuggestions.length + 2,
    15,
    layout.input.y,
  );
  const commandPaletteWidth = Math.min(66, Math.max(0, layout.width - 2));
  return (
    <Box
      position="relative"
      width={layout.width}
      height={layout.height}
      flexDirection="column"
      backgroundColor={colors.background}
      overflow="hidden"
    >
      <Box
        width={layout.main.width}
        height={layout.main.height}
        flexDirection="column"
        backgroundColor={colors.background}
        overflow="hidden"
        flexShrink={0}
      >
        {headerHeight > 0 && (
          <Box
            height={headerHeight}
            paddingX={1}
            borderStyle="single"
            borderBottom
            borderTop={false}
            borderLeft={false}
            borderRight={false}
            borderColor={colors.border}
            borderBottomBackgroundColor={colors.background}
            backgroundColor={colors.background}
            justifyContent="space-between"
            flexShrink={0}
            overflow="hidden"
          >
            <Box
              width={fullHeader ? Math.floor(layout.width * 0.38) : undefined}
              flexGrow={fullHeader ? 0 : 1}
              columnGap={2}
              overflow="hidden"
            >
              <Text color={colors.accent} bold>
                eulr
              </Text>
              <Text color={colors.border}>│</Text>
              <Text color={colors.muted} wrap="truncate-middle">
                ◇ {state.cwd}
              </Text>
            </Box>
            {fullHeader && (
              <Box
                width={Math.floor(layout.width * 0.28)}
                justifyContent="center"
                overflow="hidden"
              >
                <Text color={colors.muted} wrap="truncate-middle">
                  {state.providerId} · {state.model}
                  {state.reasoningEffort === undefined
                    ? ""
                    : ` · ${state.reasoningEffort}`}
                </Text>
              </Box>
            )}
            <Box
              width={fullHeader ? undefined : 14}
              flexGrow={fullHeader ? 1 : 0}
              justifyContent="flex-end"
              columnGap={2}
              overflow="hidden"
            >
              <Text
                color={state.phase === "idle" ? colors.accent : colors.muted}
              >
                ● {state.phase}
              </Text>
              {fullHeader && (
                <>
                  <Text color={colors.border}>│</Text>
                  <Text color={colors.muted} wrap="truncate-end">
                    {state.task === undefined
                      ? "no active task"
                      : `session ${state.sessionId}`}
                  </Text>
                </>
              )}
            </Box>
          </Box>
        )}
        <Box
          width={layout.main.width}
          height={contentHeight}
          backgroundColor={colors.background}
          flexShrink={0}
          overflow="hidden"
        >
          {layout.main.height <= 0 ? null : working ? (
            <WorkingScreen
              state={state}
              width={layout.main.width}
              height={contentHeight}
              mode={layout.mode}
            />
          ) : (
            <IdleScreen
              state={state}
              width={layout.main.width}
              height={contentHeight}
            />
          )}
        </Box>
        {state.overlay !== undefined && (
          <Overlay
            overlay={state.overlay}
            width={layout.main.width}
            height={layout.main.height}
          />
        )}
      </Box>
      <InputArea
        state={state}
        input={input}
        width={layout.input.width}
        height={layout.input.height}
      />
      <BottomDock state={state} layout={layout} />
      {commandPalette !== undefined && commandPaletteHeight >= 3 && (
        <CommandPalette
          items={commandSuggestions}
          selectedIndex={commandPalette.selectedIndex}
          width={commandPaletteWidth}
          height={commandPaletteHeight}
          top={layout.input.y - commandPaletteHeight}
          left={layout.width >= 3 ? 1 : 0}
        />
      )}
    </Box>
  );
}
