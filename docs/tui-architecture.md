# TUI architecture

`eulr` uses Ink 7 with React 19 for its full-screen terminal interface. Ink is
an ESM-native Node.js renderer, supports Node 22, alternate-screen rendering,
incremental redraw, raw keyboard input, bracketed paste, focus, and resize, and
continues to install as an ordinary `pnpm` global package on Linux and macOS.

OpenTUI 0.4.3 was evaluated first. Its native renderer currently requires
Node.js 26.4 with experimental FFI flags. Raising the runtime and requiring
those flags would break eulr's Node 22 executable contract, so OpenTUI is not a
practical baseline for this version.

## Boundaries

The agent core emits provider-independent `AgentEvent` values. `AgentTuiEventBridge`
maps those events into `TuiStore`; neither layer imports provider SDK types. A
permission broker implements the existing asynchronous permission callback and
resolves it from the fixed input region. Tool metadata supplies bounded live
file previews, before/after text, and command output without changing message or
JSONL session formats.

`TuiController` owns interactive commands, task cancellation, queued follow-up,
runtime replacement for new/resumed sessions, and music commands. React
components only render store snapshots and forward key input to the controller.

The root is a vertical constraint layout with permanent region order:

1. dynamic main area;
2. input area;
3. bottom dock.

The dock is always a horizontal companion/music split. Scroll offsets belong to
the activity and inspector viewports, so neither can move the input or dock.

## Music boundary

`MusicService` owns the independent `remote`, `local`, and `off` source state;
the dock only renders its typed snapshot. The default remote adapter uses native
`fetch` plus Zod for the public catalog and now-playing contracts. It passes the
current track URL to the existing mpv JSON IPC backend, synchronizes to the
server position, refreshes periodically and after end-of-file, and applies a
seek only when position drift crosses the configured threshold. HTTP or schema
failures become an offline player state with bounded backoff, never a TUI or
agent failure.

Local mode retains the filesystem scanner and persisted library settings. Off
mode starts neither HTTP transport nor mpv. Audio is deliberately absent from
the npm package.

## Terminal lifecycle

Ink owns raw mode, bracketed paste, alternate-screen entry, resize, and normal
unmount restoration. eulr wraps the renderer in an idempotent lifecycle guard
that unmounts on normal exit, SIGINT, SIGTERM, render failure, uncaught
exception, or unhandled rejection before the plain CLI prints an error. Debug
messages are redacted and written under `~/.eulr/logs/`, never to the active
screen.

Before Ink is loaded, full-screen mode enables at least indexed color even when
plain output uses `NO_COLOR`. Root, main, input, dock, panel interiors, and
border cells all receive explicit backgrounds. This prevents gaps from falling
back to a terminal's transparent default color. eulr does not use terminal-
specific opacity controls; global compositor opacity remains a terminal setting.

## Companion assets

The current repository has no companion raster assets and Ink has no stable
cross-terminal inline-image primitive. `CompanionArtwork` therefore uses the
neutral `eulr ✦` mark and isolates artwork from panel layout. The following
package paths are reserved for a later capability adapter:

- `assets/companion/idle.png`
- `assets/companion/thinking.png`
- `assets/companion/working.png`
- `assets/companion/waiting.png`
- `assets/companion/completed.png`
- `assets/companion/error.png`

Unsupported image protocols and missing assets always fall back to the neutral
mark.
