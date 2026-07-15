import { Box, Text } from "ink";

import type { ActivityItem } from "../types.js";
import { colors } from "../theme/colors.js";
import { PanelFrame } from "./panel-frame.js";
import { viewportSlice } from "./view-utils.js";

interface ActivityRow {
  key: string;
  text: string;
  color: string;
}

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
  const rows = buildActivityRows(activities, frame, bodyHeight > 4);
  const viewport = viewportSlice(rows, bodyHeight, offset);
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
      <Box
        flexDirection="column"
        width="100%"
        height={bodyHeight}
        flexShrink={0}
        overflow="hidden"
      >
        {viewport.items.map((row) => (
          <Box
            key={row.key}
            width="100%"
            height={1}
            flexShrink={0}
            overflow="hidden"
          >
            <Text color={row.color} wrap="truncate-end">
              {row.text}
            </Text>
          </Box>
        ))}
        {activities.length === 0 && (
          <Text color={colors.muted}>Waiting for the first activity…</Text>
        )}
      </Box>
    </PanelFrame>
  );
}

function buildActivityRows(
  activities: readonly ActivityItem[],
  frame: number,
  showDetails: boolean,
): ActivityRow[] {
  return activities.flatMap((item, itemIndex) => {
    const rows: ActivityRow[] = [
      {
        key: `${item.id}-${itemIndex}-label`,
        text: `${statusSymbol(item.status, frame)} ${item.label}`,
        color: statusColor(item.status),
      },
    ];
    if (showDetails && item.detail !== undefined) {
      rows.push({
        key: `${item.id}-${itemIndex}-detail`,
        text: `  └─ ${item.detail}`,
        color: colors.muted,
      });
    }
    return rows;
  });
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
