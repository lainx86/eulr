import path from "node:path";

import { Box, Text } from "ink";

import type { FileViewState } from "../types.js";
import { colors } from "../theme/colors.js";
import { viewportSlice } from "./view-utils.js";
import { displayLine, displayText } from "../display-text.js";

export function CodeView({
  file,
  width,
  height,
  vertical,
  horizontal,
}: {
  file?: FileViewState;
  width: number;
  height: number;
  vertical: number;
  horizontal: number;
}): React.JSX.Element {
  if (file === undefined)
    return <Text color={colors.muted}>No file inspected yet.</Text>;
  const sourceLines = displayText(file.content).split("\n");
  const gutter = Math.max(2, String(sourceLines.length).length);
  const viewport = viewportSlice(sourceLines, height - 1, vertical);
  const contentWidth = Math.max(1, width - gutter - 4);
  const extension = path.extname(file.path).toLowerCase();
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text color={colors.accent} wrap="truncate-middle">
        {file.path}
        {file.truncated ? " · preview truncated" : ""}
      </Text>
      {viewport.items.map((sourceLine, index) => {
        const line = displayLine(sourceLine).slice(
          Math.max(0, horizontal),
          Math.max(0, horizontal) + contentWidth,
        );
        return (
          <Text key={`${viewport.start + index}-${line}`} wrap="truncate-end">
            <Text color={colors.muted}>
              {String(viewport.start + index + 1).padStart(gutter)} │{" "}
            </Text>
            <Text color={syntaxColor(line, extension)}>{line}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function syntaxColor(line: string, extension: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#")) return colors.muted;
  if ([".ts", ".tsx", ".js", ".jsx", ".json"].includes(extension)) {
    if (
      /^(import|export|interface|type|class|const|let|function)\b/u.test(
        trimmed,
      )
    ) {
      return colors.info;
    }
    if (/^["'`]/u.test(trimmed)) return colors.warning;
  }
  return colors.foreground;
}
