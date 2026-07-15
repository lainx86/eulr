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
  const bodyHeight = Math.max(0, height - 3);
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
      flexShrink={0}
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
        width="100%"
        height={bodyHeight}
        flexDirection="column"
        paddingX={1}
        flexShrink={0}
        backgroundColor={colors.surface}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}
