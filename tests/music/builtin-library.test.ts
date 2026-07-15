import { realpath } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { builtInMusicLibraryPath } from "../../src/music/builtin-library.js";
import { scanMusicLibrary } from "../../src/music/library.js";

describe("built-in music library", () => {
  it("resolves package assets independently of the working directory", async () => {
    const expected = await realpath(
      path.resolve(import.meta.dirname, "../../assets/music/tracks"),
    );

    await expect(realpath(builtInMusicLibraryPath())).resolves.toBe(expected);
  });

  it("ships a deterministic CC0 playlist with supported audio files", async () => {
    const library = await scanMusicLibrary(builtInMusicLibraryPath());
    const secondScan = await scanMusicLibrary(builtInMusicLibraryPath());
    const trackIds = library.tracks.map((track) => track.id);

    expect(trackIds.length).toBeGreaterThan(0);
    expect(new Set(trackIds).size).toBe(trackIds.length);
    expect(secondScan.tracks.map((track) => track.id)).toEqual(trackIds);
    expect(library.tracks.every((track) => track.path !== undefined)).toBe(
      true,
    );
  });
});
