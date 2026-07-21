import { Box, Text } from "ink";

import {
  INTERACTIVE_COMMANDS,
  type InteractiveCommandDefinition,
} from "../../cli/commands.js";
import { colors } from "../theme/colors.js";

export function getSlashCommandSuggestions(
  input: string,
): readonly InteractiveCommandDefinition[] {
  if (!input.startsWith("/") || /\s/u.test(input)) return [];
  const query = input.toLowerCase();
  return INTERACTIVE_COMMANDS.filter(({ command }) =>
    command.startsWith(query),
  );
}

export function clampCommandSelection(
  selection: number,
  itemCount: number,
): number {
  if (itemCount <= 0) return 0;
  return Math.min(itemCount - 1, Math.max(0, selection));
}

export function moveCommandSelection(
  selection: number,
  delta: number,
  itemCount: number,
): number {
  if (itemCount <= 0) return 0;
  return (selection + delta + itemCount) % itemCount;
}

export function CommandPalette({
  items,
  selectedIndex,
  width,
  height,
  top,
  left,
}: {
  items: readonly InteractiveCommandDefinition[];
  selectedIndex: number;
  width: number;
  height: number;
  top: number;
  left: number;
}): React.JSX.Element | null {
  if (items.length === 0 || width < 4 || height < 3) return null;

  const selected = clampCommandSelection(selectedIndex, items.length);
  const rowCount = Math.max(1, height - 2);
  const start = Math.min(
    Math.max(0, selected - Math.floor(rowCount / 2)),
    Math.max(0, items.length - rowCount),
  );
  const visibleItems = items.slice(start, start + rowCount);
  const showDescription = width >= 42;
  const usageWidth = Math.min(
    showDescription ? 23 : Math.max(1, width - 5),
    Math.max(...items.map(({ usage }) => usage.length)) + 2,
  );

  return (
    <Box
      position="absolute"
      top={top}
      left={left}
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.borderStrong}
      backgroundColor={colors.surface}
      borderTopBackgroundColor={colors.surface}
      borderBottomBackgroundColor={colors.surface}
      borderLeftBackgroundColor={colors.surface}
      borderRightBackgroundColor={colors.surface}
      overflow="hidden"
    >
      {visibleItems.map((item, visibleIndex) => {
        const index = start + visibleIndex;
        const active = index === selected;
        return (
          <Box
            key={item.command}
            height={1}
            width="100%"
            paddingX={1}
            columnGap={2}
            backgroundColor={active ? colors.accent : colors.surface}
            overflow="hidden"
          >
            <Box width={usageWidth} flexShrink={0} overflow="hidden">
              <Text
                color={active ? colors.background : colors.accent}
                bold={active}
                wrap="truncate-end"
              >
                {active ? "› " : "  "}
                {item.usage}
              </Text>
            </Box>
            {showDescription && (
              <Text
                color={active ? colors.background : colors.muted}
                wrap="truncate-end"
              >
                {item.description}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
