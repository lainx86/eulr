import { createElement } from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { MusicPlayerPanel } from "../../src/tui/panels/music-player-panel.js";
import type { MusicUiState } from "../../src/tui/types.js";

describe("MusicPlayerPanel", () => {
  it("keeps metadata, progress, transport, and volume in clean full-mode rows", () => {
    const output = renderMusic({
      ...baseState(),
      playing: true,
      elapsedSeconds: 67,
      durationSeconds: 204,
      trackIndex: 0,
      trackCount: 8,
      track: {
        id: "midnight-equations.mp3",
        title: "midnight equations",
        artist: "kupla",
        album: "lo-fi horizons",
      },
    });

    expect(output).toContain("♪ midnight equations");
    expect(output).toContain("PLAYING");
    expect(output).toContain("kupla · lo-fi horizons");
    expect(output).toContain("1:07");
    expect(output).toContain("3:24");
    expect(output).toContain("│◀");
    expect(output).toContain("▶│");
    expect(output).toContain("vol 70%");
  });

  it("distinguishes an empty library from an unavailable backend", () => {
    const empty = renderMusic(baseState());
    expect(empty).toContain("No tracks loaded");
    expect(empty).toContain("EMPTY");
    expect(empty).toContain("Use /music library <path>");

    const unavailable = renderMusic({
      ...baseState(),
      available: false,
      statusMessage: "mpv not available",
    });
    expect(unavailable).toContain("OFFLINE");
    expect(unavailable).toContain("mpv not available · /music status");
  });

  it("retains a concise one-line player in minimum mode", () => {
    const output = renderMusic(baseState(), "minimum", 48, 4);
    expect(output).toContain("No tracks loaded");
    expect(output).toContain("70%");
    expect(output.split("\n")).toHaveLength(4);
  });
});

function renderMusic(
  music: MusicUiState,
  mode: "full" | "compact" | "minimum" = "full",
  width = 96,
  height = 8,
): string {
  return renderToString(
    createElement(MusicPlayerPanel, {
      music,
      width,
      height,
      mode,
      active: false,
    }),
    { columns: width },
  );
}

function baseState(): MusicUiState {
  return {
    available: true,
    statusMessage: "No tracks loaded",
    playing: false,
    elapsedSeconds: 0,
    durationSeconds: 0,
    volume: 70,
    shuffle: false,
    repeat: false,
    trackIndex: -1,
    trackCount: 0,
  };
}
