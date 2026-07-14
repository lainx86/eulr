import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanMusicLibrary } from "../../src/music/library.js";
import { CancellationError } from "../../src/utils/errors.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("scanMusicLibrary", () => {
  it("recursively returns supported audio files in deterministic order", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "Album"));
    await writeFile(path.join(root, "z.MP3"), "audio");
    await writeFile(path.join(root, "Album", "02-song.flac"), "audio");
    await writeFile(path.join(root, "Album", "01-song.ogg"), "audio");
    await writeFile(path.join(root, "cover.jpg"), "image");
    await writeFile(path.join(root, "notes.txt"), "text");

    const library = await scanMusicLibrary(root);

    expect(library.root).toBe(await realpath(root));
    expect(library.tracks.map((track) => track.id)).toEqual([
      "Album/01-song.ogg",
      "Album/02-song.flac",
      "z.MP3",
    ]);
    expect(library.tracks.map((track) => track.title)).toEqual([
      "01-song",
      "02-song",
      "z",
    ]);
  });

  it("returns an empty catalog for a library without audio", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "README.md"), "nothing to play");

    await expect(scanMusicLibrary(root)).resolves.toMatchObject({ tracks: [] });
  });

  it.skipIf(process.platform === "win32")(
    "does not follow file or directory symlinks outside the selected root",
    async () => {
      const root = await workspace();
      const outside = await workspace();
      await writeFile(path.join(outside, "secret.mp3"), "outside");
      await symlink(
        path.join(outside, "secret.mp3"),
        path.join(root, "escape.mp3"),
      );
      await symlink(outside, path.join(root, "external"));
      await writeFile(path.join(root, "inside.mp3"), "inside");

      const library = await scanMusicLibrary(root);

      expect(library.tracks.map((track) => track.id)).toEqual(["inside.mp3"]);
      expect(library.tracks.every((track) => track.path.startsWith(root))).toBe(
        true,
      );
    },
  );

  it("honors cancellation before touching the library", async () => {
    const root = await workspace();
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(
      scanMusicLibrary(root, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it("fails explicitly instead of silently truncating an oversized catalog", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "one.mp3"), "one");
    await writeFile(path.join(root, "two.mp3"), "two");

    await expect(scanMusicLibrary(root, { maxTracks: 1 })).rejects.toThrow(
      /more than 1/u,
    );
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "eulr-music-library-"));
  roots.push(root);
  return root;
}
