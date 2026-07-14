import path from "node:path";

import { redactText } from "../auth/redaction.js";
import type { ConfigStore } from "../config/config-store.js";
import type { MusicConfig } from "../config/schema.js";
import { isAbortError } from "../utils/errors.js";
import { MusicError } from "./errors.js";
import {
  scanMusicLibrary,
  type MusicLibrary,
  type ScanMusicLibraryOptions,
} from "./library.js";
import { MpvBackend } from "./mpv-backend.js";
import type {
  MusicBackend,
  MusicBackendEvent,
  MusicBackendState,
  MusicCommand,
  MusicPlaybackState,
  MusicStateListener,
  MusicTrack,
} from "./types.js";

const DEFAULT_VOLUME = 70;
const DEFAULT_PROGRESS_DEBOUNCE_MS = 5_000;

type LibraryScanner = (
  libraryPath: string,
  options?: ScanMusicLibraryOptions,
) => Promise<MusicLibrary>;

export interface MusicServiceOptions {
  configStore: ConfigStore;
  backend?: MusicBackend;
  backendFactory?: () => MusicBackend;
  scanLibrary?: LibraryScanner;
  progressDebounceMs?: number;
}

export class MusicService {
  private readonly configStore: ConfigStore;
  private readonly suppliedBackend: MusicBackend | undefined;
  private readonly backendFactory: () => MusicBackend;
  private readonly scanLibrary: LibraryScanner;
  private readonly progressDebounceMs: number;
  private readonly listeners = new Set<MusicStateListener>();
  private tracks: MusicTrack[] = [];
  private backend: MusicBackend | undefined;
  private unsubscribeBackend: (() => void) | undefined;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private backendReady = false;
  private backendFailed = false;
  private playlistLoaded = false;
  private progressTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private state: MusicPlaybackState = {
    available: true,
    statusMessage: "No tracks loaded",
    playing: false,
    elapsedSeconds: 0,
    durationSeconds: 0,
    volume: DEFAULT_VOLUME,
    shuffle: false,
    repeat: false,
    trackIndex: -1,
    trackCount: 0,
  };

  constructor(options: MusicServiceOptions) {
    this.configStore = options.configStore;
    this.suppliedBackend = options.backend;
    this.backendFactory = options.backendFactory ?? (() => new MpvBackend());
    this.scanLibrary = options.scanLibrary ?? scanMusicLibrary;
    this.progressDebounceMs =
      options.progressDebounceMs ?? DEFAULT_PROGRESS_DEBOUNCE_MS;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise === undefined) {
      const operation = this.loadPersistedState();
      this.initializePromise = operation;
      void operation
        .finally(() => {
          if (this.initializePromise === operation) {
            this.initializePromise = undefined;
          }
        })
        .catch(() => undefined);
    }
    await this.initializePromise;
  }

  getState(): MusicPlaybackState {
    return cloneState(this.state);
  }

  subscribe(listener: MusicStateListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.getState());
    } catch {
      // A UI listener must not break playback state management.
    }
    return () => this.listeners.delete(listener);
  }

  async execute(
    command: MusicCommand,
    signal?: AbortSignal,
  ): Promise<MusicPlaybackState> {
    this.assertOpen();
    await this.initialize();
    switch (command.type) {
      case "library":
        await this.setLibrary(command.path, signal);
        break;
      case "play":
        await this.play(signal);
        break;
      case "pause":
        await this.pause(signal);
        break;
      case "toggle":
        if (!this.playlistLoaded) await this.play(signal);
        else
          await this.runBackendCommand(
            (backend) => backend.toggle(signal),
            "Unable to toggle music playback",
            signal,
          );
        await this.refreshBackendState(signal);
        break;
      case "next":
        await this.changeTrack("next", signal);
        break;
      case "previous":
        await this.changeTrack("previous", signal);
        break;
      case "seek":
        await this.seek(command.seconds, signal);
        break;
      case "volume":
        await this.setVolume(command.volume, signal);
        break;
      case "shuffle":
        await this.setShuffle(!this.state.shuffle, signal);
        break;
      case "repeat":
        await this.setRepeat(!this.state.repeat, signal);
        break;
      case "status":
        await this.refreshBackendState(signal);
        break;
    }
    this.notify();
    return this.getState();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.progressTimer !== undefined) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    if (this.initialized) {
      await this.persistPlayback().catch(() => undefined);
    }
    this.unsubscribeBackend?.();
    this.unsubscribeBackend = undefined;
    const backend = this.backend;
    this.backend = undefined;
    if (backend !== undefined) {
      await backend.close().catch(() => undefined);
    }
  }

  private async loadPersistedState(): Promise<void> {
    const config = await this.configStore.load();
    const music = config.music ?? {};
    this.state = {
      ...this.state,
      volume: music.volume ?? DEFAULT_VOLUME,
      shuffle: music.shuffle ?? false,
      repeat: music.repeat ?? false,
      elapsedSeconds: music.positionSeconds ?? 0,
      ...(music.libraryPath ? { libraryPath: music.libraryPath } : {}),
    };

    if (music.libraryPath !== undefined) {
      try {
        const library = await this.scanLibrary(music.libraryPath);
        this.applyLibrary(library, music.lastTrack);
        this.state.statusMessage =
          library.tracks.length === 0
            ? "The music library contains no supported audio files."
            : `Music library ready (${library.tracks.length} tracks).`;
      } catch (error) {
        this.state.statusMessage = `Music library unavailable: ${safeMessage(error)}`;
      }
    }
    this.initialized = true;
    this.notify();
  }

  private async setLibrary(
    libraryPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const library = await this.scanLibrary(libraryPath, { signal });
    this.applyLibrary(library);
    this.playlistLoaded = false;
    this.state.elapsedSeconds = 0;
    this.state.durationSeconds = 0;
    this.state.playing = false;
    this.state.statusMessage =
      library.tracks.length === 0
        ? "The music library contains no supported audio files."
        : `Music library loaded (${library.tracks.length} tracks).`;
    await this.configStore.updateMusic({
      libraryPath: library.root,
      lastTrack: this.state.track?.id,
      positionSeconds: 0,
    });
  }

  private applyLibrary(library: MusicLibrary, lastTrack?: string): void {
    this.tracks = library.tracks;
    let index =
      lastTrack === undefined
        ? -1
        : this.tracks.findIndex((track) => track.id === lastTrack);
    if (index < 0 && this.tracks.length > 0) index = 0;
    const track = index >= 0 ? this.tracks[index] : undefined;
    this.state = {
      ...this.state,
      libraryPath: library.root,
      trackIndex: index,
      trackCount: this.tracks.length,
      ...(track === undefined ? { track: undefined } : { track }),
    };
  }

  private async play(signal?: AbortSignal): Promise<void> {
    if (this.tracks.length === 0) {
      this.state.statusMessage = this.state.libraryPath
        ? "The music library contains no supported audio files."
        : "Set a music library with /music library <path>.";
      return;
    }
    const backend = await this.ensureBackend(signal);
    if (backend === undefined) return;
    if (!this.playlistLoaded) {
      const index = Math.max(0, this.state.trackIndex);
      const loaded = await this.runBackendCommand(
        async (activeBackend) => {
          await activeBackend.loadPlaylist(
            this.tracks.map((track) => track.path),
            index,
            signal,
          );
          await activeBackend.setVolume(this.state.volume, signal);
          await activeBackend.setRepeat(this.state.repeat, signal);
          if (this.state.shuffle) {
            await activeBackend.setShuffle(true, signal);
          }
          if (this.state.elapsedSeconds > 0) {
            await activeBackend.seek(this.state.elapsedSeconds, signal);
          }
        },
        "Unable to load the music playlist",
        signal,
      );
      if (!loaded) return;
      this.playlistLoaded = true;
    }
    const played = await this.runBackendCommand(
      (activeBackend) => activeBackend.play(signal),
      "Unable to start music playback",
      signal,
    );
    if (!played) return;
    this.state.playing = true;
    this.state.statusMessage = this.state.track
      ? `Playing ${this.state.track.title}`
      : "Playing music.";
    await this.refreshBackendState(signal);
    await this.persistPlayback();
  }

  private async pause(signal?: AbortSignal): Promise<void> {
    if (!this.playlistLoaded || !this.backendReady) {
      this.state.playing = false;
      this.state.statusMessage = "Music is not playing.";
      return;
    }
    const paused = await this.runBackendCommand(
      (backend) => backend.pause(signal),
      "Unable to pause music playback",
      signal,
    );
    if (!paused) return;
    this.state.playing = false;
    this.state.statusMessage = "Music paused.";
    await this.refreshBackendState(signal);
    await this.persistPlayback();
  }

  private async changeTrack(
    direction: "next" | "previous",
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.playlistLoaded) {
      await this.play(signal);
      return;
    }
    const changed = await this.runBackendCommand(
      (backend) =>
        direction === "next" ? backend.next(signal) : backend.previous(signal),
      `Unable to select the ${direction} track`,
      signal,
    );
    if (!changed) return;
    await this.refreshBackendState(signal);
    await this.persistPlayback();
  }

  private async seek(seconds: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new MusicError("Music seek position must be a nonnegative number");
    }
    this.state.elapsedSeconds = seconds;
    if (this.backendReady) {
      await this.runBackendCommand(
        (backend) => backend.seek(seconds, signal),
        "Unable to seek music playback",
        signal,
      );
    }
    await this.persistPlayback();
  }

  private async setVolume(volume: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new MusicError("Music volume must be between 0 and 100");
    }
    this.state.volume = volume;
    if (this.backendReady) {
      await this.runBackendCommand(
        (backend) => backend.setVolume(volume, signal),
        "Unable to change music volume",
        signal,
      );
    }
    await this.configStore.updateMusic({ volume });
  }

  private async setShuffle(
    shuffle: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.state.shuffle = shuffle;
    if (this.backendReady && this.playlistLoaded) {
      await this.runBackendCommand(
        (backend) => backend.setShuffle(shuffle, signal),
        "Unable to change music shuffle mode",
        signal,
      );
      await this.refreshBackendState(signal);
    }
    this.state.statusMessage = `Shuffle ${shuffle ? "enabled" : "disabled"}.`;
    await this.configStore.updateMusic({ shuffle });
  }

  private async setRepeat(
    repeat: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.state.repeat = repeat;
    if (this.backendReady) {
      await this.runBackendCommand(
        (backend) => backend.setRepeat(repeat, signal),
        "Unable to change music repeat mode",
        signal,
      );
    }
    this.state.statusMessage = `Repeat ${repeat ? "enabled" : "disabled"}.`;
    await this.configStore.updateMusic({ repeat });
  }

  private async ensureBackend(
    signal?: AbortSignal,
  ): Promise<MusicBackend | undefined> {
    if (this.backendReady && this.backend !== undefined) return this.backend;
    if (this.backendFailed) return undefined;
    const backend =
      this.backend ?? this.suppliedBackend ?? this.backendFactory();
    this.backend = backend;
    if (this.unsubscribeBackend === undefined) {
      this.unsubscribeBackend = backend.subscribe((event) =>
        this.handleBackendEvent(event),
      );
    }
    try {
      await backend.initialize(signal);
      this.backendReady = true;
      this.state.available = true;
      return backend;
    } catch (error) {
      if (isAbortError(error)) throw error;
      await this.markBackendUnavailable(error);
      return undefined;
    }
  }

  private async runBackendCommand(
    operation: (backend: MusicBackend) => Promise<void>,
    context: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const backend = await this.ensureBackend(signal);
    if (backend === undefined) return false;
    try {
      await operation(backend);
      return true;
    } catch (error) {
      if (isAbortError(error)) throw error;
      await this.markBackendUnavailable(error, context);
      return false;
    }
  }

  private async refreshBackendState(signal?: AbortSignal): Promise<void> {
    if (!this.backendReady || this.backend === undefined) return;
    try {
      this.applyBackendState(await this.backend.getState(signal));
    } catch (error) {
      if (isAbortError(error)) throw error;
      await this.markBackendUnavailable(error, "Unable to read music status");
    }
  }

  private applyBackendState(update: Partial<MusicBackendState>): void {
    const previousTrack = this.state.track?.id;
    if (update.path !== undefined) {
      const normalized = path.resolve(update.path);
      const index = this.tracks.findIndex(
        (track) => path.resolve(track.path) === normalized,
      );
      if (index >= 0) {
        this.state.trackIndex = index;
        this.state.track = this.tracks[index];
      }
    }
    if (
      this.state.track !== undefined &&
      (update.title !== undefined ||
        update.artist !== undefined ||
        update.album !== undefined)
    ) {
      const enrichedTrack: MusicTrack = {
        ...this.state.track,
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.artist === undefined ? {} : { artist: update.artist }),
        ...(update.album === undefined ? {} : { album: update.album }),
      };
      this.state.track = enrichedTrack;
      if (this.state.trackIndex >= 0) {
        this.tracks[this.state.trackIndex] = enrichedTrack;
      }
    }
    if (update.playing !== undefined) this.state.playing = update.playing;
    if (update.elapsedSeconds !== undefined)
      this.state.elapsedSeconds = Math.max(0, update.elapsedSeconds);
    if (update.durationSeconds !== undefined)
      this.state.durationSeconds = Math.max(0, update.durationSeconds);
    if (update.volume !== undefined)
      this.state.volume = Math.max(0, Math.min(100, update.volume));
    this.state.trackCount = this.tracks.length;
    if (this.state.track?.id !== previousTrack) {
      this.state.elapsedSeconds = 0;
      void this.persistPlayback().catch(() => undefined);
    } else {
      this.scheduleProgressPersistence();
    }
  }

  private handleBackendEvent(event: MusicBackendEvent): void {
    if (this.closed) return;
    if (event.type === "unavailable") {
      this.backendReady = false;
      this.backendFailed = true;
      this.state.available = false;
      this.state.playing = false;
      this.state.statusMessage = `Music backend unavailable: ${redactText(event.message)}`;
    } else {
      this.applyBackendState(event.state);
      this.state.available = true;
      if (this.state.playing && this.state.track) {
        this.state.statusMessage = `Playing ${this.state.track.title}`;
      }
    }
    this.notify();
  }

  private async markBackendUnavailable(
    error: unknown,
    context = "Music backend unavailable",
  ): Promise<void> {
    this.backendReady = false;
    this.backendFailed = true;
    this.playlistLoaded = false;
    this.state.available = false;
    this.state.playing = false;
    this.state.statusMessage = `${context}: ${safeMessage(error)}`;
    const backend = this.backend;
    if (backend !== undefined) await backend.close().catch(() => undefined);
    this.notify();
  }

  private scheduleProgressPersistence(): void {
    if (this.progressDebounceMs <= 0) {
      void this.persistPlayback().catch(() => undefined);
      return;
    }
    if (this.progressTimer !== undefined) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      void this.persistPlayback().catch(() => undefined);
    }, this.progressDebounceMs);
    this.progressTimer.unref();
  }

  private async persistPlayback(): Promise<void> {
    const patch: Partial<MusicConfig> = {
      positionSeconds: this.state.elapsedSeconds,
    };
    if (this.state.track !== undefined) patch.lastTrack = this.state.track.id;
    await this.configStore.updateMusic(patch);
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // UI listeners are isolated from playback state transitions.
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new MusicError("Music service has been closed");
  }
}

function cloneState(state: MusicPlaybackState): MusicPlaybackState {
  return {
    ...state,
    ...(state.track === undefined ? {} : { track: { ...state.track } }),
  };
}

function safeMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}

export { DEFAULT_PROGRESS_DEBOUNCE_MS, DEFAULT_VOLUME };
