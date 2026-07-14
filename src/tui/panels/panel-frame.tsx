import type { ReactNode } from "react";
import { Box, Text } from "ink";

import { colors } from "../theme/colors.js";

export interface PanelFrameProps {
  title: string;
  active?: boolean;
  width?: number;
  height: number;
  children: ReactNode;
  accent?: string;
}

export function PanelFrame({
  title,
  active = false,
  width,
  height,
  children,
  accent = colors.accent,
}: PanelFrameProps): React.JSX.Element {
  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? accent : colors.border}
      borderBackgroundColor={colors.surface}
      backgroundColor={colors.surface}
      borderDimColor={!active}
      overflow="hidden"
    >
      <Box
        height={1}
        paddingX={1}
        flexShrink={0}
        backgroundColor={colors.surface}
      >
        <Text
          color={active ? accent : colors.muted}
          bold={active}
          wrap="truncate-end"
        >
          {title}
        </Text>
      </Box>
      <Box
        flexDirection="column"
        paddingX={1}
        flexGrow={1}
        backgroundColor={colors.surface}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}
