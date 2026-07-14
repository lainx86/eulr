export interface MusicTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  path: string;
}

export interface MusicPlaybackState {
  available: boolean;
  statusMessage: string;
  playing: boolean;
  track?: MusicTrack;
  elapsedSeconds: number;
  durationSeconds: number;
  volume: number;
  shuffle: boolean;
  repeat: boolean;
  libraryPath?: string;
  trackIndex: number;
  trackCount: number;
}

export type MusicCommand =
  | { type: "library"; path: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seek"; seconds: number }
  | { type: "volume"; volume: number }
  | { type: "shuffle" }
  | { type: "repeat" }
  | { type: "status" };

export interface MusicBackendState {
  playing: boolean;
  path?: string;
  title?: string;
  artist?: string;
  album?: string;
  elapsedSeconds: number;
  durationSeconds: number;
  volume: number;
  trackIndex: number;
  trackCount: number;
}

export type MusicBackendEvent =
  | { type: "state"; state: Partial<MusicBackendState> }
  | { type: "unavailable"; message: string };

export interface MusicBackend {
  initialize(signal?: AbortSignal): Promise<void>;
  loadPlaylist(
    paths: readonly string[],
    trackIndex: number,
    signal?: AbortSignal,
  ): Promise<void>;
  play(signal?: AbortSignal): Promise<void>;
  pause(signal?: AbortSignal): Promise<void>;
  toggle(signal?: AbortSignal): Promise<void>;
  next(signal?: AbortSignal): Promise<void>;
  previous(signal?: AbortSignal): Promise<void>;
  seek(seconds: number, signal?: AbortSignal): Promise<void>;
  setVolume(volume: number, signal?: AbortSignal): Promise<void>;
  setShuffle(shuffle: boolean, signal?: AbortSignal): Promise<void>;
  setRepeat(repeat: boolean, signal?: AbortSignal): Promise<void>;
  getState(signal?: AbortSignal): Promise<MusicBackendState>;
  subscribe(listener: (event: MusicBackendEvent) => void): () => void;
  close(): Promise<void>;
}

export type MusicStateListener = (state: MusicPlaybackState) => void;
