import { Box, Text } from "ink";

import type { InspectorState, ScrollState } from "../types.js";
import { colors } from "../theme/colors.js";
import { AnswerView } from "./answer-view.js";
import { CodeView } from "./code-view.js";
import { DiffView } from "./diff-view.js";
import { OutputView } from "./output-view.js";
import { PanelFrame } from "./panel-frame.js";

const TABS = ["changes", "file", "output", "answer"] as const;

export function InspectorPanel({
  inspector,
  scroll,
  width,
  height,
  active,
}: {
  inspector: InspectorState;
  scroll: ScrollState["inspector"];
  width?: number;
  height: number;
  active: boolean;
}): React.JSX.Element {
  const bodyWidth = Math.max(1, (width ?? 80) - 4);
  const bodyHeight = Math.max(1, height - 5);
  const tabScroll = scroll[inspector.activeTab];
  return (
    <PanelFrame
      title="CONTEXT INSPECTOR"
      active={active}
      height={height}
      width={width}
    >
      <Box height={1} columnGap={2} flexShrink={0} overflow="hidden">
        {TABS.map((tab) => (
          <Text
            key={tab}
            color={tab === inspector.activeTab ? colors.accent : colors.muted}
            bold={tab === inspector.activeTab}
          >
            {titleCase(tab)}
          </Text>
        ))}
      </Box>
      <Box
        marginTop={1}
        height={bodyHeight}
        flexDirection="column"
        overflow="hidden"
      >
        {inspector.activeTab === "changes" && (
          <DiffView
            change={inspector.change}
            width={bodyWidth}
            height={bodyHeight}
            vertical={tabScroll.vertical}
            horizontal={tabScroll.horizontal}
          />
        )}
        {inspector.activeTab === "file" && (
          <CodeView
            file={inspector.file}
            width={bodyWidth}
            height={bodyHeight}
            vertical={tabScroll.vertical}
            horizontal={tabScroll.horizontal}
          />
        )}
        {inspector.activeTab === "output" && (
          <OutputView
            output={inspector.output}
            width={bodyWidth}
            height={bodyHeight}
            vertical={tabScroll.vertical}
            horizontal={tabScroll.horizontal}
          />
        )}
        {inspector.activeTab === "answer" && (
          <AnswerView
            answer={inspector.answer}
            width={bodyWidth}
            height={bodyHeight}
            vertical={tabScroll.vertical}
            horizontal={tabScroll.horizontal}
          />
        )}
      </Box>
    </PanelFrame>
  );
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
