import { Box, Text } from "ink";

import type { ActivityItem } from "../types.js";
import { colors } from "../theme/colors.js";
import { PanelFrame } from "./panel-frame.js";

export function ActivityPanel({
  task,
  activities,
  height,
  width,
  offset,
  active,
  frame,
}: {
  task?: string;
  activities: readonly ActivityItem[];
  height: number;
  width?: number;
  offset: number;
  active: boolean;
  frame: number;
}): React.JSX.Element {
  const bodyHeight = Math.max(0, height - 5);
  const available = activities.slice(
    Math.max(0, Math.min(offset, Math.max(0, activities.length - bodyHeight))),
  );
  return (
    <PanelFrame
      title="ACTIVITY / PROGRESS"
      active={active}
      height={height}
      width={width}
    >
      {task !== undefined && (
        <Box height={2} flexShrink={0}>
          <Text color={colors.foreground} bold wrap="truncate-end">
            › {task}
          </Text>
        </Box>
      )}
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {available.slice(0, bodyHeight).map((item) => (
          <Box key={item.id} flexDirection="column" flexShrink={0}>
            <Text color={statusColor(item.status)} wrap="truncate-end">
              {statusSymbol(item.status, frame)} {item.label}
            </Text>
            {item.detail !== undefined && bodyHeight > 4 && (
              <Text color={colors.muted} wrap="truncate-end">
                {"  └─ "}
                {item.detail}
              </Text>
            )}
          </Box>
        ))}
        {activities.length === 0 && (
          <Text color={colors.muted}>Waiting for the first activity…</Text>
        )}
      </Box>
    </PanelFrame>
  );
}

function statusColor(status: ActivityItem["status"]): string {
  if (status === "active") return colors.accent;
  if (status === "completed") return colors.success;
  if (status === "failed") return colors.danger;
  return colors.muted;
}

function statusSymbol(status: ActivityItem["status"], frame: number): string {
  if (status === "active") return ["◐", "◓", "◑", "◒"][frame % 4] ?? "◉";
  if (status === "completed") return "●";
  if (status === "failed") return "✗";
  if (status === "cancelled") return "–";
  return "○";
}
