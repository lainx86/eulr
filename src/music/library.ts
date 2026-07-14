import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { CancellationError } from "../utils/errors.js";
import { MusicLibraryError } from "./errors.js";
import type { MusicTrack } from "./types.js";

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".wma",
]);

export interface ScanMusicLibraryOptions {
  signal?: AbortSignal;
  maxTracks?: number;
  maxDepth?: number;
}

export interface MusicLibrary {
  root: string;
  tracks: MusicTrack[];
}

export async function scanMusicLibrary(
  libraryPath: string,
  options: ScanMusicLibraryOptions = {},
): Promise<MusicLibrary> {
  throwIfCancelled(options.signal);
  let root: string;
  try {
    root = await realpath(libraryPath);
    if (!(await stat(root)).isDirectory()) {
      throw new MusicLibraryError(
        `Music library is not a directory: ${libraryPath}`,
      );
    }
  } catch (error) {
    if (error instanceof MusicLibraryError) throw error;
    throw new MusicLibraryError(
      `Unable to open music library: ${libraryPath}`,
      {
        cause: error,
      },
    );
  }

  const tracks: MusicTrack[] = [];
  const visitedDirectories = new Set<string>();
  const maxTracks = options.maxTracks ?? 50_000;
  const maxDepth = options.maxDepth ?? 64;
  const pending: Array<{ directory: string; depth: number }> = [
    { directory: root, depth: 0 },
  ];

  while (pending.length > 0) {
    throwIfCancelled(options.signal);
    const item = pending.pop();
    if (item === undefined || visitedDirectories.has(item.directory)) continue;
    visitedDirectories.add(item.directory);

    let entries;
    try {
      entries = await readdir(item.directory, { withFileTypes: true });
    } catch (error) {
      throw new MusicLibraryError(
        `Unable to scan music directory: ${item.directory}`,
        { cause: error },
      );
    }
    entries.sort((left, right) => compareNames(left.name, right.name));

    for (const entry of entries) {
      throwIfCancelled(options.signal);
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(item.directory, entry.name);

      if (entry.isDirectory()) {
        if (item.depth >= maxDepth) {
          throw new MusicLibraryError(
            `Music library exceeds the maximum scan depth of ${maxDepth}: ${candidate}`,
          );
        }
        const canonicalDirectory = await canonicalWithinRoot(root, candidate);
        if (canonicalDirectory !== undefined) {
          pending.push({
            directory: canonicalDirectory,
            depth: item.depth + 1,
          });
        }
        continue;
      }

      if (!entry.isFile() || !isAudioFile(entry.name)) continue;
      const canonicalFile = await canonicalWithinRoot(root, candidate);
      if (canonicalFile === undefined) continue;
      let details;
      try {
        details = await stat(canonicalFile);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
      if (!details.isFile()) continue;

      const id = path.relative(root, canonicalFile).split(path.sep).join("/");
      tracks.push({
        id,
        title: path.basename(entry.name, path.extname(entry.name)),
        path: canonicalFile,
      });
      if (tracks.length > maxTracks) {
        throw new MusicLibraryError(
          `Music library contains more than ${maxTracks} supported tracks`,
        );
      }
    }
  }

  tracks.sort((left, right) => compareNames(left.id, right.id));
  return { root, tracks };
}

function isAudioFile(fileName: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function canonicalWithinRoot(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const relative = path.relative(root, canonical);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
    ? canonical
    : undefined;
}

function compareNames(left: string, right: string): number {
  const insensitive = left.localeCompare(right, "en", { sensitivity: "base" });
  return insensitive === 0 ? left.localeCompare(right, "en") : insensitive;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CancellationError("Music library scan cancelled", {
      cause: signal.reason,
    });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export { AUDIO_EXTENSIONS };
