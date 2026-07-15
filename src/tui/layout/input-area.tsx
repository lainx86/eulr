import { Box, Text } from "ink";

import type { InputBufferSnapshot } from "../state/input-buffer.js";
import type { TuiState } from "../types.js";
import { colors } from "../theme/colors.js";
import { displayText } from "../display-text.js";

export function InputArea({
  state,
  input,
  width,
  height,
}: {
  state: TuiState;
  input: InputBufferSnapshot;
  width: number;
  height: number;
}): React.JSX.Element {
  const permission = state.permission?.request;
  const showHelper = height >= 4;
  const fieldHeight = Math.max(0, height - (showHelper ? 1 : 0));

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      backgroundColor={colors.background}
      overflow="hidden"
      flexShrink={0}
    >
      <Box
        width={width}
        height={fieldHeight}
        borderStyle="round"
        borderColor={
          permission
            ? colors.warning
            : state.focus === "input"
              ? colors.accent
              : colors.border
        }
        borderBackgroundColor={colors.surface}
        backgroundColor={colors.surface}
        paddingX={1}
        alignItems="center"
        overflow="hidden"
        flexShrink={0}
      >
        {permission === undefined ? (
          <Box width="100%" justifyContent="space-between" overflow="hidden">
            <Box flexGrow={1} overflow="hidden">
              <Text color={colors.accent} bold>
                eulr ›{" "}
              </Text>
              <EditableText snapshot={input} active={state.focus === "input"} />
            </Box>
            {width >= 58 && (
              <Text color={colors.accent} wrap="truncate-end">
                ↵ send
              </Text>
            )}
          </Box>
        ) : (
          <Box width="100%" justifyContent="space-between" columnGap={2}>
            <Text color={colors.warning} bold wrap="truncate-end">
              eulr wants to {permissionVerb(permission.category)}:{" "}
              {permission.target}
            </Text>
            <Text color={colors.foreground} wrap="truncate-end">
              [Y] allow once · [A] session · [N] deny
            </Text>
          </Box>
        )}
      </Box>

      {showHelper && (
        <Box
          height={1}
          paddingX={2}
          justifyContent="space-between"
          backgroundColor={colors.background}
          overflow="hidden"
          flexShrink={0}
        >
          <Text
            color={
              permission?.risk === undefined ? colors.muted : colors.danger
            }
            wrap="truncate-end"
          >
            {permission?.risk ??
              "esc interrupt · / commands · alt+enter newline · tab focus"}
          </Text>
          {state.queuedFollowUp !== undefined && (
            <Text color={colors.warning} wrap="truncate-middle">
              queued · {state.queuedFollowUp}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function permissionVerb(category: string): string {
  if (category === "write") return "edit";
  if (category.includes("execute")) return "run";
  return "read";
}

function EditableText({
  snapshot,
  active,
}: {
  snapshot: InputBufferSnapshot;
  active: boolean;
}): React.JSX.Element {
  const selection = snapshot.selection;
  const cursor = active ? snapshot.cursor : -1;
  const before = displayText(
    snapshot.value.slice(0, selection?.start ?? cursor),
  );
  if (selection !== null) {
    return (
      <Text wrap="truncate-end">
        {before}
        <Text inverse>
          {displayText(snapshot.value.slice(selection.start, selection.end)) ||
            " "}
        </Text>
        {displayText(snapshot.value.slice(selection.end))}
      </Text>
    );
  }
  if (cursor < 0)
    return (
      <Text color={colors.muted} wrap="truncate-end">
        {displayText(snapshot.value) || "Ask eulr anything…"}
      </Text>
    );
  return (
    <Text
      wrap="truncate-end"
      color={snapshot.value === "" ? colors.muted : colors.foreground}
    >
      {displayText(snapshot.value.slice(0, cursor))}
      <Text inverse>{displayText(snapshot.value[cursor] ?? " ")}</Text>
      {displayText(snapshot.value.slice(cursor + 1))}
    </Text>
  );
}
