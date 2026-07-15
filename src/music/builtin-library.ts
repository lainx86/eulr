import { fileURLToPath } from "node:url";

const BUILT_IN_MUSIC_LIBRARY_URL = new URL(
  "../../assets/music/tracks/",
  import.meta.url,
);

/** Resolves correctly from both src/music and the compiled dist/music output. */
export function builtInMusicLibraryPath(): string {
  return fileURLToPath(BUILT_IN_MUSIC_LIBRARY_URL);
}

export { BUILT_IN_MUSIC_LIBRARY_URL };
