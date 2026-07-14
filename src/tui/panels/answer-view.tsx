import { Text } from "ink";

import { colors } from "../theme/colors.js";
import { viewportLines } from "./view-utils.js";

export function AnswerView({
  answer,
  width,
  height,
  vertical,
  horizontal,
}: {
  answer: string;
  width: number;
  height: number;
  vertical: number;
  horizontal: number;
}): React.JSX.Element {
  const lines =
    answer === ""
      ? ["Assistant response will appear here."]
      : answer.split("\n");
  return (
    <Text
      color={answer === "" ? colors.muted : colors.foreground}
      wrap="truncate-end"
    >
      {viewportLines(lines, height, vertical, width, horizontal).join("\n")}
    </Text>
  );
}
