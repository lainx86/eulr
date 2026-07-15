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
import {
  RemoteMusicClient,
  resolveMusicServiceUrl,
  synchronizedPositionSeconds,
  type RemoteCatalog,
  type RemoteMusicProvider,
  type RemoteNowPlaying,
  type RemoteTrack,
} from "./remote-music-client.js";
import type {
  MusicBackend,
  MusicBackendEvent,
  MusicBackendState,
  MusicCommand,
  MusicPlaybackState,
  MusicSource,
  MusicStateListener,
  MusicTrack,
} from "./types.js";

const DEFAULT_VOLUME = 70;
const DEFAULT_PROGRESS_DEBOUNCE_MS = 5_000;
const DEFAULT_REMOTE_REFRESH_MS = 15_000;
const DEFAULT_REMOTE_RETRY_BASE_MS = 2_000;
const DEFAULT_REMOTE_RETRY_MAX_MS = 60_000;
const DEFAULT_REMOTE_DRIFT_THRESHOLD_SECONDS = 5;

type LibraryScanner = (
  libraryPath: string,
  options?: ScanMusicLibraryOptions,
) => Promise<MusicLibrary>;

export interface MusicServiceOptions {
  configStore: ConfigStore;
  backend?: MusicBackend;
  backendFactory?: () => MusicBackend;
  scanLibrary?: LibraryScanner;
  remoteClient?: RemoteMusicProvider;
  remoteClientFactory?: (baseUrl: string) => RemoteMusicProvider;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  progressDebounceMs?: number;
  remoteRefreshMs?: number;
  remoteRetryBaseMs?: number;
  remoteRetryMaxMs?: number;
  remoteDriftThresholdSeconds?: number;
}

export class MusicService {
  private readonly configStore: ConfigStore;
  private readonly suppliedBackend: MusicBackend | undefined;
  private readonly backendFactory: () => MusicBackend;
  private readonly scanLibrary: LibraryScanner;
  private readonly suppliedRemoteClient: RemoteMusicProvider | undefined;
  private readonly remoteClientFactory: (
    baseUrl: string,
  ) => RemoteMusicProvider;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly progressDebounceMs: number;
  private readonly remoteRefreshMs: number;
  private readonly remoteRetryBaseMs: number;
  private readonly remoteRetryMaxMs: number;
  private readonly remoteDriftThresholdSeconds: number;
  private readonly listeners = new Set<MusicStateListener>();
  private tracks: MusicTrack[] = [];
  private backend: MusicBackend | undefined;
  private unsubscribeBackend: (() => void) | undefined;
  private remoteClient: RemoteMusicProvider | undefined;
  private remoteCatalog: RemoteCatalog | undefined;
  private remoteAbortController: AbortController | undefined;
  private remoteRefreshPromise: Promise<boolean> | undefined;
  private remoteTimer: NodeJS.Timeout | undefined;
  private remoteFailures = 0;
  private remoteOnline = false;
  private remoteShouldPlay = false;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private backendReady = false;
  private backendFailed = false;
  private playlistLoaded = false;
  private progressTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private state: MusicPlaybackState = {
    available: true,
    statusMessage: "Connecting to eulr focus radio",
    playing: false,
    elapsedSeconds: 0,
    durationSeconds: 0,
    volume: DEFAULT_VOLUME,
    shuffle: false,
    repeat: false,
    source: "remote",
    trackIndex: -1,
    trackCount: 0,
  };

  constructor(options: MusicServiceOptions) {
    this.configStore = options.configStore;
    this.suppliedBackend = options.backend;
    this.backendFactory = options.backendFactory ?? (() => new MpvBackend());
    this.scanLibrary = options.scanLibrary ?? scanMusicLibrary;
    this.suppliedRemoteClient = options.remoteClient;
    this.remoteClientFactory =
      options.remoteClientFactory ??
      ((baseUrl) => new RemoteMusicClient({ baseUrl }));
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.progressDebounceMs =
      options.progressDebounceMs ?? DEFAULT_PROGRESS_DEBOUNCE_MS;
    this.remoteRefreshMs = options.remoteRefreshMs ?? DEFAULT_REMOTE_REFRESH_MS;
    this.remoteRetryBaseMs =
      options.remoteRetryBaseMs ?? DEFAULT_REMOTE_RETRY_BASE_MS;
    this.remoteRetryMaxMs =
      options.remoteRetryMaxMs ?? DEFAULT_REMOTE_RETRY_MAX_MS;
    this.remoteDriftThresholdSeconds =
      options.remoteDriftThresholdSeconds ??
      DEFAULT_REMOTE_DRIFT_THRESHOLD_SECONDS;
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
      case "remote":
        await this.setRemoteSource(signal);
        break;
      case "local":
        await this.setLocalSource(signal);
        break;
      case "off":
        await this.setOffSource(signal);
        break;
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
        if (this.state.playing || this.remoteShouldPlay)
          await this.pause(signal);
        else await this.play(signal);
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
        if (this.state.source === "remote")
          await this.refreshRemote(false, signal);
        else await this.refreshBackendState(signal);
        break;
    }
    this.notify();
    return this.getState();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearRemoteTimer();
    this.cancelRemoteRefresh();
    if (this.progressTimer !== undefined) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    if (this.initialized && this.state.source === "local") {
      await this.persistPlayback().catch(() => undefined);
    }
    this.unsubscribeBackend?.();
    this.unsubscribeBackend = undefined;
    const backend = this.backend;
    this.backend = undefined;
    if (backend !== undefined) await backend.close().catch(() => undefined);
  }

  private async loadPersistedState(): Promise<void> {
    const config = await this.configStore.load();
    const music = config.music ?? {};
    const source = persistedSource(music);
    const serviceUrl = resolveMusicServiceUrl(
      music.serviceUrl,
      this.environment,
    );
    this.remoteClient =
      this.suppliedRemoteClient ?? this.remoteClientFactory(serviceUrl);
    this.state = {
      ...this.state,
      source,
      serviceUrl,
      volume: music.volume ?? DEFAULT_VOLUME,
      shuffle: music.shuffle ?? false,
      repeat: music.repeat ?? false,
      elapsedSeconds: source === "local" ? (music.positionSeconds ?? 0) : 0,
      ...(music.libraryPath === undefined
        ? {}
        : { libraryPath: music.libraryPath }),
    };

    if (source === "local") {
      await this.loadLocalLibrary(music.libraryPath, music.lastTrack);
    } else if (source === "off") {
      this.applyOffState();
    } else {
      this.state.statusMessage = "Connecting to eulr focus radio";
      this.scheduleRemoteRefresh(0);
    }
    this.initialized = true;
    this.notify();
  }

  private async setRemoteSource(signal?: AbortSignal): Promise<void> {
    await this.pauseForSourceChange(signal);
    this.clearRemoteTimer();
    this.tracks = [];
    this.remoteCatalog = undefined;
    this.remoteOnline = false;
    this.playlistLoaded = false;
    this.remoteShouldPlay = false;
    this.state = {
      ...this.state,
      source: "remote",
      available: true,
      playing: false,
      track: undefined,
      elapsedSeconds: 0,
      durationSeconds: 0,
      trackIndex: -1,
      trackCount: 0,
      statusMessage: "Connecting to eulr focus radio",
    };
    await this.configStore.updateMusic({ source: "remote" });
    await this.refreshRemote(true, signal);
  }

  private async setLocalSource(signal?: AbortSignal): Promise<void> {
    const config = await this.configStore.load();
    const libraryPath = config.music?.libraryPath;
    if (libraryPath === undefined) {
      throw new MusicError(
        "No local music library is configured. Use /music library <path>.",
      );
    }
    await this.pauseForSourceChange(signal);
    this.clearRemoteTimer();
    this.cancelRemoteRefresh();
    this.remoteShouldPlay = false;
    this.playlistLoaded = false;
    this.state.source = "local";
    this.state.available = true;
    this.state.elapsedSeconds = config.music?.positionSeconds ?? 0;
    await this.loadLocalLibrary(libraryPath, config.music?.lastTrack, signal);
    await this.configStore.updateMusic({ source: "local" });
  }

  private async setOffSource(signal?: AbortSignal): Promise<void> {
    await this.pauseForSourceChange(signal);
    this.clearRemoteTimer();
    this.cancelRemoteRefresh();
    this.remoteShouldPlay = false;
    this.playlistLoaded = false;
    this.tracks = [];
    this.applyOffState();
    await this.configStore.updateMusic({ source: "off" });
  }

  private applyOffState(): void {
    this.state = {
      ...this.state,
      source: "off",
      available: true,
      playing: false,
      track: undefined,
      elapsedSeconds: 0,
      durationSeconds: 0,
      trackIndex: -1,
      trackCount: 0,
      statusMessage: "Music is off",
    };
  }

  private async setLibrary(
    libraryPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const library = await this.scanLibrary(libraryPath, { signal });
    await this.pauseForSourceChange(signal);
    this.clearRemoteTimer();
    this.cancelRemoteRefresh();
    this.remoteShouldPlay = false;
    this.applyLibrary(library);
    this.playlistLoaded = false;
    this.state.elapsedSeconds = 0;
    this.state.durationSeconds = 0;
    this.state.playing = false;
    this.state.available = true;
    this.state.statusMessage =
      library.tracks.length === 0
        ? "The music library contains no supported audio files."
        : `Local music library loaded (${library.tracks.length} tracks).`;
    await this.configStore.updateMusic({
      source: "local",
      libraryPath: library.root,
      lastTrack: this.state.track?.id,
      positionSeconds: 0,
    });
  }

  private async loadLocalLibrary(
    libraryPath: string | undefined,
    lastTrack?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (libraryPath === undefined) {
      this.tracks = [];
      this.state = {
        ...this.state,
        source: "local",
        track: undefined,
        trackIndex: -1,
        trackCount: 0,
        statusMessage: "No local music library configured",
      };
      return;
    }
    try {
      const library = await this.scanLibrary(libraryPath, { signal });
      this.applyLibrary(library, lastTrack);
      this.state.available = true;
      this.state.statusMessage =
        library.tracks.length === 0
          ? "The music library contains no supported audio files."
          : `Local music library ready (${library.tracks.length} tracks).`;
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.tracks = [];
      this.state = {
        ...this.state,
        source: "local",
        available: false,
        playing: false,
        track: undefined,
        trackIndex: -1,
        trackCount: 0,
        statusMessage: `Local music library unavailable: ${safeMessage(error)}`,
      };
    }
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
      source: "local",
      libraryPath: library.root,
      trackIndex: index,
      trackCount: this.tracks.length,
      ...(track === undefined ? { track: undefined } : { track }),
    };
  }

  private async refreshRemote(
    includeCatalog: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.state.source !== "remote" || this.closed) return false;
    if (this.remoteRefreshPromise !== undefined) {
      return this.remoteRefreshPromise;
    }
    this.clearRemoteTimer();
    const controller = new AbortController();
    this.remoteAbortController = controller;
    const requestSignal =
      signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal]);
    const operation = this.performRemoteRefresh(includeCatalog, requestSignal);
    this.remoteRefreshPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.remoteRefreshPromise === operation) {
        this.remoteRefreshPromise = undefined;
      }
      if (this.remoteAbortController === controller) {
        this.remoteAbortController = undefined;
      }
    }
  }

  private async performRemoteRefresh(
    includeCatalog: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const client = this.remoteClient;
    if (client === undefined) return false;
    try {
      const shouldLoadCatalog =
        includeCatalog || this.remoteCatalog === undefined;
      const [catalog, nowPlaying] = await Promise.all([
        shouldLoadCatalog
          ? client.getCatalog(signal)
          : Promise.resolve(this.remoteCatalog),
        client.getNowPlaying(signal),
      ]);
      if (catalog !== undefined) this.remoteCatalog = catalog;
      this.remoteFailures = 0;
      this.remoteOnline = true;
      await this.applyRemoteNowPlaying(nowPlaying, signal);
      this.scheduleRemoteRefresh(this.remoteRefreshMs);
      return true;
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.remoteFailures += 1;
      this.remoteOnline = false;
      const retryMs = Math.min(
        this.remoteRetryMaxMs,
        this.remoteRetryBaseMs * 2 ** (this.remoteFailures - 1),
      );
      this.state.available = false;
      this.state.statusMessage = `Remote radio offline; retrying in ${formatRetry(retryMs)}: ${safeMessage(error)}`;
      this.scheduleRemoteRefresh(retryMs);
      this.notify();
      return false;
    }
  }

  private async applyRemoteNowPlaying(
    nowPlaying: RemoteNowPlaying,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.state.source !== "remote") return;
    const expectedPosition = synchronizedPositionSeconds(
      nowPlaying,
      this.now(),
    );
    const changed = this.state.track?.id !== nowPlaying.track.id;
    const remoteTracks = orderedRemoteTracks(this.remoteCatalog);
    const track = remoteTrackToMusicTrack(nowPlaying.track);
    this.tracks = remoteTracks;
    let index = remoteTracks.findIndex(
      (candidate) => candidate.id === nowPlaying.track.id,
    );
    if (index < 0) {
      this.tracks = [track, ...remoteTracks];
      index = 0;
    }
    const backendUnavailable = this.remoteShouldPlay && this.backendFailed;
    this.state = {
      ...this.state,
      source: "remote",
      available: !backendUnavailable,
      track,
      elapsedSeconds: expectedPosition,
      durationSeconds: nowPlaying.track.durationSeconds,
      trackIndex: index,
      trackCount: this.tracks.length,
      statusMessage: backendUnavailable
        ? this.state.statusMessage
        : this.remoteShouldPlay
          ? `Playing ${track.title}`
          : `Remote radio ready · ${track.title}`,
    };

    if (changed) this.playlistLoaded = false;
    if (this.remoteShouldPlay && !this.playlistLoaded) {
      await this.loadRemoteTrack(track, expectedPosition, signal);
    } else if (
      this.remoteShouldPlay &&
      this.playlistLoaded &&
      this.backendReady &&
      this.backend !== undefined
    ) {
      const backendState = await this.backend.getState(signal);
      this.applyBackendState(backendState);
      const drift = Math.abs(backendState.elapsedSeconds - expectedPosition);
      if (drift >= this.remoteDriftThresholdSeconds) {
        await this.backend.seek(expectedPosition, signal);
        this.state.elapsedSeconds = expectedPosition;
      }
    }
    this.notify();
  }

  private async loadRemoteTrack(
    track: MusicTrack,
    positionSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const backend = await this.ensureBackend(signal);
    if (backend === undefined) return;
    const location = track.audioUrl ?? track.path;
    const loaded = await this.runBackendCommand(
      async (activeBackend) => {
        await activeBackend.loadPlaylist([location], 0, signal);
        await activeBackend.setVolume(this.state.volume, signal);
        await activeBackend.setRepeat(false, signal);
        if (positionSeconds > 0) {
          await activeBackend.seek(positionSeconds, signal);
        }
        await activeBackend.play(signal);
      },
      "Unable to start remote radio",
      signal,
    );
    if (!loaded) return;
    this.playlistLoaded = true;
    this.state.playing = true;
    this.state.available = this.remoteOnline;
    this.state.elapsedSeconds = positionSeconds;
    this.state.statusMessage = this.remoteOnline
      ? `Playing ${track.title}`
      : `Remote radio offline; playing cached ${track.title}`;
  }

  private scheduleRemoteRefresh(delayMs: number): void {
    if (this.closed || this.state.source !== "remote") return;
    this.clearRemoteTimer();
    this.remoteTimer = setTimeout(
      () => {
        this.remoteTimer = undefined;
        void this.refreshRemote(false).catch(() => undefined);
      },
      Math.max(0, delayMs),
    );
    this.remoteTimer.unref();
  }

  private clearRemoteTimer(): void {
    if (this.remoteTimer === undefined) return;
    clearTimeout(this.remoteTimer);
    this.remoteTimer = undefined;
  }

  private cancelRemoteRefresh(): void {
    this.remoteAbortController?.abort(
      new DOMException("Remote music refresh cancelled", "AbortError"),
    );
    this.remoteAbortController = undefined;
  }

  private async pauseForSourceChange(signal?: AbortSignal): Promise<void> {
    if (!this.backendReady || this.backend === undefined) return;
    try {
      await this.backend.pause(signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      await this.markBackendUnavailable(
        error,
        "Unable to pause music before changing source",
      );
    }
  }

  private async play(signal?: AbortSignal): Promise<void> {
    if (this.state.source === "off") {
      this.state.statusMessage =
        "Music is off. Use /music remote or /music local.";
      return;
    }
    if (this.state.source === "remote") {
      this.remoteShouldPlay = true;
      await this.refreshRemote(false, signal);
      if (this.state.track === undefined) return;
      if (this.state.playing && this.playlistLoaded) return;
      if (!this.playlistLoaded) {
        await this.loadRemoteTrack(
          this.state.track,
          this.state.elapsedSeconds,
          signal,
        );
      } else if (this.backendReady) {
        await this.runBackendCommand(
          (backend) => backend.play(signal),
          "Unable to start remote radio",
          signal,
        );
        this.state.playing = true;
      }
      return;
    }
    await this.playLocal(signal);
  }

  private async playLocal(signal?: AbortSignal): Promise<void> {
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
        "Unable to load the local music playlist",
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
      : "Playing music";
    await this.refreshBackendState(signal);
    await this.persistPlayback();
  }

  private async pause(signal?: AbortSignal): Promise<void> {
    this.remoteShouldPlay = false;
    if (!this.playlistLoaded || !this.backendReady) {
      this.state.playing = false;
      this.state.statusMessage = "Music is not playing";
      return;
    }
    const paused = await this.runBackendCommand(
      (backend) => backend.pause(signal),
      "Unable to pause music playback",
      signal,
    );
    if (!paused) return;
    this.state.playing = false;
    this.state.statusMessage = "Music paused";
    await this.refreshBackendState(signal);
    if (this.state.source === "local") await this.persistPlayback();
  }

  private async changeTrack(
    direction: "next" | "previous",
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.state.source === "remote") {
      const refreshed = await this.refreshRemote(true, signal);
      if (refreshed) {
        this.state.statusMessage =
          "Remote radio follows the live station schedule";
      }
      return;
    }
    if (this.state.source !== "local") return;
    if (!this.playlistLoaded) {
      await this.playLocal(signal);
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
    if (this.state.source === "local") await this.persistPlayback();
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
    if (
      this.state.source === "local" &&
      this.backendReady &&
      this.playlistLoaded
    ) {
      await this.runBackendCommand(
        (backend) => backend.setShuffle(shuffle, signal),
        "Unable to change music shuffle mode",
        signal,
      );
    }
    this.state.statusMessage = `Shuffle ${shuffle ? "enabled" : "disabled"}`;
    await this.configStore.updateMusic({ shuffle });
  }

  private async setRepeat(
    repeat: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.state.repeat = repeat;
    if (this.state.source === "local" && this.backendReady) {
      await this.runBackendCommand(
        (backend) => backend.setRepeat(repeat, signal),
        "Unable to change music repeat mode",
        signal,
      );
    }
    this.state.statusMessage = `Repeat ${repeat ? "enabled" : "disabled"}`;
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
      this.state.available =
        this.state.source === "remote" ? this.remoteOnline : true;
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
      const index =
        this.state.source === "remote"
          ? this.tracks.findIndex(
              (track) =>
                track.audioUrl === update.path || track.path === update.path,
            )
          : this.tracks.findIndex(
              (track) =>
                path.resolve(track.path) === path.resolve(update.path ?? ""),
            );
      if (index >= 0) {
        this.state.trackIndex = index;
        this.state.track = this.tracks[index];
      }
    }
    if (
      this.state.source === "local" &&
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
    if (update.durationSeconds !== undefined && update.durationSeconds > 0)
      this.state.durationSeconds = update.durationSeconds;
    if (update.volume !== undefined)
      this.state.volume = Math.max(0, Math.min(100, update.volume));
    this.state.trackCount = this.tracks.length;
    if (this.state.source !== "local") return;
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
    } else if (event.type === "ended") {
      if (this.state.source === "remote") {
        this.playlistLoaded = false;
        this.state.playing = false;
        this.clearRemoteTimer();
        void this.refreshRemoteAfterTrackEnd().catch(() => undefined);
      }
    } else {
      this.applyBackendState(event.state);
      if (this.state.playing && this.state.track) {
        this.state.statusMessage = `Playing ${this.state.track.title}`;
      }
    }
    this.notify();
  }

  private async refreshRemoteAfterTrackEnd(): Promise<void> {
    const inFlight = this.remoteRefreshPromise;
    if (inFlight !== undefined) {
      await inFlight.catch(() => false);
    }
    if (this.closed || this.state.source !== "remote") return;
    await this.refreshRemote(false);
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
    if (this.state.source !== "local") return;
    const patch: Partial<MusicConfig> = {
      source: "local",
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

function persistedSource(music: MusicConfig): MusicSource {
  if (music.source !== undefined) return music.source;
  return music.libraryPath === undefined ? "remote" : "local";
}

function orderedRemoteTracks(catalog: RemoteCatalog | undefined): MusicTrack[] {
  if (catalog === undefined) return [];
  const byId = new Map(catalog.tracks.map((track) => [track.id, track]));
  return catalog.station.trackIds.flatMap((id) => {
    const track = byId.get(id);
    return track === undefined ? [] : [remoteTrackToMusicTrack(track)];
  });
}

function remoteTrackToMusicTrack(track: RemoteTrack): MusicTrack {
  return {
    id: track.id,
    title: track.title,
    ...(track.artist === undefined ? {} : { artist: track.artist }),
    path: track.audioUrl,
    audioUrl: track.audioUrl,
    durationSeconds: track.durationSeconds,
  };
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

function formatRetry(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${milliseconds} ms`
    : `${Math.ceil(milliseconds / 1_000)} s`;
}

export {
  DEFAULT_PROGRESS_DEBOUNCE_MS,
  DEFAULT_REMOTE_DRIFT_THRESHOLD_SECONDS,
  DEFAULT_REMOTE_REFRESH_MS,
  DEFAULT_REMOTE_RETRY_BASE_MS,
  DEFAULT_REMOTE_RETRY_MAX_MS,
  DEFAULT_VOLUME,
};
