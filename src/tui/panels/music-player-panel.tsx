import { Box, Text } from "ink";

import type { LayoutMode } from "../layout/constraints.js";
import type { MusicUiState } from "../types.js";
import { colors } from "../theme/colors.js";
import { formatDuration, progressBar } from "./view-utils.js";
import { PanelFrame } from "./panel-frame.js";

export function MusicPlayerPanel({
  music,
  width,
  height,
  mode,
  active,
}: {
  music: MusicUiState;
  width: number;
  height: number;
  mode: LayoutMode;
  active: boolean;
}): React.JSX.Element {
  const hasTrack = music.track !== undefined;
  const title = music.track?.title ?? music.statusMessage;
  const duration = music.durationSeconds;
  const progress = duration > 0 ? music.elapsedSeconds / duration : 0;
  const barWidth = Math.max(4, width - 16);

  return (
    <PanelFrame
      title="MUSIC PLAYER"
      height={height}
      width={width}
      active={active}
      accent={colors.music}
    >
      {mode === "minimum" ? (
        <Box justifyContent="space-between" overflow="hidden">
          <Text
            wrap="truncate-end"
            color={music.available ? colors.foreground : colors.muted}
          >
            {music.playing ? "▶" : "Ⅱ"} {title}
          </Text>
          <Text color={colors.muted}>{Math.round(music.volume)}%</Text>
        </Box>
      ) : (
        <Box
          flexDirection="column"
          height={Math.max(1, height - 3)}
          overflow="hidden"
        >
          <Box height={1} justifyContent="space-between" overflow="hidden">
            <Text
              color={hasTrack ? colors.foreground : colors.muted}
              bold
              wrap="truncate-end"
            >
              ♪ {title}
            </Text>
            <Text color={playbackColor(music)} bold={music.playing}>
              {playbackLabel(music)}
            </Text>
          </Box>

          {mode === "full" && (
            <Box height={1} justifyContent="space-between" overflow="hidden">
              <Text color={colors.muted} wrap="truncate-end">
                {trackDetails(music)}
              </Text>
              <Text color={colors.muted}>
                {music.trackCount > 0
                  ? `${music.trackIndex + 1} / ${music.trackCount}`
                  : ""}
              </Text>
            </Box>
          )}

          <Box
            height={1}
            marginTop={mode === "full" ? 1 : 0}
            columnGap={1}
            overflow="hidden"
          >
            <Text color={colors.muted}>
              {formatDuration(music.elapsedSeconds)}
            </Text>
            <Text color={music.available ? colors.accent : colors.border}>
              {progressBar(progress, barWidth)}
            </Text>
            <Text color={colors.muted}>{formatDuration(duration)}</Text>
          </Box>

          <Box height={1} justifyContent="space-between" overflow="hidden">
            <Box columnGap={2} overflow="hidden">
              <Text color={music.shuffle ? colors.accent : colors.border}>
                ⇄
              </Text>
              <Text color={colors.muted}>│◀</Text>
              <Text
                color={music.playing ? colors.accent : colors.foreground}
                bold
              >
                {music.playing ? "Ⅱ" : "▶"}
              </Text>
              <Text color={colors.muted}>▶│</Text>
              <Text color={music.repeat ? colors.accent : colors.border}>
                ↻
              </Text>
            </Box>
            <Text color={colors.muted}>vol {Math.round(music.volume)}%</Text>
          </Box>
        </Box>
      )}
    </PanelFrame>
  );
}

function playbackLabel(music: MusicUiState): string {
  if (music.source === "off") return "OFF";
  if (!music.available) return "OFFLINE";
  if (music.track === undefined) return "EMPTY";
  return music.playing ? "PLAYING" : "PAUSED";
}

function playbackColor(music: MusicUiState): string {
  if (!music.available || music.track === undefined) return colors.muted;
  return music.playing ? colors.accent : colors.foreground;
}

function trackDetails(music: MusicUiState): string {
  if (music.source === "off") return "Music disabled · /music remote";
  if (!music.available) return music.statusMessage;
  if (music.track === undefined)
    return music.source === "remote"
      ? "Remote radio · connecting"
      : "Use /music library <path>";
  const metadata = [music.track.artist, music.track.album]
    .filter(Boolean)
    .join(" · ");
  if (metadata !== "") return metadata;
  if (music.source === "remote") return "eulr focus radio · CC0";
  return music.libraryPath || "Local music library";
}
