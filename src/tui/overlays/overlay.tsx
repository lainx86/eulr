import { Box, Text } from "ink";

import { INTERACTIVE_HELP } from "../../cli/commands.js";
import type { OverlayState } from "../types.js";
import { colors } from "../theme/colors.js";

export function Overlay({
  overlay,
  width,
  height,
}: {
  overlay: OverlayState;
  width: number;
  height: number;
}): React.JSX.Element {
  const panelWidth = Math.max(24, Math.min(width - 4, 76));
  const panelHeight = Math.max(
    5,
    Math.min(height - 2, overlay.type === "help" ? 17 : 16),
  );
  return (
    <Box
      position="absolute"
      top={Math.max(0, Math.floor((height - panelHeight) / 2))}
      left={Math.max(0, Math.floor((width - panelWidth) / 2))}
      width={panelWidth}
      height={panelHeight}
      borderStyle="double"
      borderColor={colors.accent}
      borderBackgroundColor={colors.surface}
      backgroundColor={colors.surface}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      overflow="hidden"
    >
      {overlay.type === "help" ? (
        <>
          <Text color={colors.accent} bold>
            eulr commands & keys
          </Text>
          <Text color={colors.foreground}>{INTERACTIVE_HELP}</Text>
          <Text color={colors.muted}>
            Tab focus · arrows navigate · Esc close · Ctrl+C interrupt/exit
          </Text>
        </>
      ) : (
        <>
          <Text color={colors.accent} bold>
            {overlay.title}
          </Text>
          <Box flexDirection="column" marginTop={1} overflow="hidden">
            {overlay.items.slice(0, panelHeight - 5).map((item, index) => (
              <Text
                key={item.id}
                color={
                  index === overlay.selectedIndex
                    ? colors.accent
                    : colors.foreground
                }
                inverse={index === overlay.selectedIndex}
                wrap="truncate-end"
              >
                {index === overlay.selectedIndex ? "› " : "  "}
                {item.label}
                {item.detail ? ` · ${item.detail}` : ""}
              </Text>
            ))}
            {overlay.items.length === 0 && (
              <Text color={colors.muted}>No entries available.</Text>
            )}
          </Box>
          <Text color={colors.muted}>
            ↑/↓ select · Enter confirm · Esc close
          </Text>
        </>
      )}
    </Box>
  );
}
