# eulr built-in music

The audio files under `tracks/` form eulr's built-in playlist. They are loaded
when no personal music library is configured, so `/music play` works without a
path. A personal library selected with `/music library <path>` takes priority;
`/music builtin` switches back to these bundled tracks.

All tracks in this directory are provided under CC0 1.0. No attribution is
required. Do not add audio under a different license without documenting that
license and its redistribution requirements here.

Every supported audio file under `tracks/` is discovered at runtime and sorted
deterministically by its relative path. New CC0 tracks can be added without
updating a hard-coded manifest.

SPDX-License-Identifier: CC0-1.0
