import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../src/config/config-store.js";
import { MusicBackendUnavailableError } from "../../src/music/errors.js";
import { MusicService } from "../../src/music/music-service.js";
import type {
  RemoteCatalog,
  RemoteMusicProvider,
  RemoteNowPlaying,
  RemoteTrack,
} from "../../src/music/remote-music-client.js";
import type {
  MusicBackend,
  MusicBackendEvent,
  MusicBackendState,
} from "../../src/music/types.js";

const roots: string[] = [];
const NOW = Date.parse("2026-07-15T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MusicService remote source", () => {
  it("uses remote radio by default and streams the audio URL to mpv at the synchronized position", async () => {
    const fixture = await remoteFixture();

    await fixture.service.initialize();
    await fixture.service.execute({ type: "play" });

    expect(fixture.service.getState()).toMatchObject({
      source: "remote",
      available: true,
      playing: true,
      track: { id: "alpha", title: "Alpha" },
      elapsedSeconds: 37,
      trackCount: 2,
    });
    expect(fixture.backend.playlist).toEqual([
      "https://music.example.test/alpha.mp3",
    ]);
    expect(fixture.backend.commands).toContain("seek:37");
    expect(
      fixture.backend.commands.filter((item) => item === "play"),
    ).toHaveLength(1);
    expect(fixture.remote.catalogCalls).toBeGreaterThan(0);
    await fixture.service.close();
  });

  it("reloads mpv when the remote station changes tracks", async () => {
    const fixture = await remoteFixture();
    await fixture.service.initialize();
    await fixture.service.execute({ type: "play" });

    fixture.remote.nowPlaying = nowPlaying(BETA_TRACK, 9, ALPHA_TRACK);
    await fixture.service.execute({ type: "status" });

    expect(fixture.service.getState()).toMatchObject({
      track: { id: "beta" },
      elapsedSeconds: 9,
    });
    expect(fixture.backend.playlist).toEqual([
      "https://music.example.test/beta.mp3",
    ]);
    expect(fixture.backend.commands).toContain("seek:9");
    await fixture.service.close();
  });

  it("detects a scheduled remote track change without user input", async () => {
    const fixture = await remoteFixture({ refreshMs: 10 });
    await fixture.service.initialize();
    await eventually(() => fixture.service.getState().track?.id === "alpha");

    fixture.remote.nowPlaying = nowPlaying(BETA_TRACK, 4, ALPHA_TRACK);

    await eventually(() => fixture.service.getState().track?.id === "beta");
    expect(fixture.remote.nowPlayingCalls).toBeGreaterThanOrEqual(2);
    await fixture.service.close();
  });

  it("refreshes now-playing and loads the current track after end-of-file", async () => {
    const fixture = await remoteFixture();
    await fixture.service.initialize();
    await fixture.service.execute({ type: "play" });
    const callsBeforeEnd = fixture.remote.nowPlayingCalls;

    fixture.remote.nowPlaying = nowPlaying(BETA_TRACK, 2, ALPHA_TRACK);
    fixture.backend.emit({ type: "ended" });

    await eventually(
      () =>
        fixture.remote.nowPlayingCalls > callsBeforeEnd &&
        fixture.service.getState().track?.id === "beta" &&
        fixture.backend.playlist[0]?.endsWith("beta.mp3") === true,
    );
    await fixture.service.close();
  });

  it("corrects playback only when remote position drift reaches the threshold", async () => {
    const fixture = await remoteFixture({ driftThresholdSeconds: 5 });
    await fixture.service.initialize();
    await fixture.service.execute({ type: "play" });
    const initialSeekCount = fixture.backend.seekCommands.length;

    fixture.backend.setElapsed(40);
    fixture.remote.nowPlaying = nowPlaying(ALPHA_TRACK, 43, BETA_TRACK);
    await fixture.service.execute({ type: "status" });
    expect(fixture.backend.seekCommands).toHaveLength(initialSeekCount);

    fixture.backend.setElapsed(40);
    fixture.remote.nowPlaying = nowPlaying(ALPHA_TRACK, 50, BETA_TRACK);
    await fixture.service.execute({ type: "status" });
    expect(fixture.backend.seekCommands.at(-1)).toBe(50);
    expect(fixture.backend.seekCommands).toHaveLength(initialSeekCount + 1);
    await fixture.service.close();
  });

  it("reports offline without throwing and retries with backoff", async () => {
    const fixture = await remoteFixture({
      catalogFailures: 1,
      retryBaseMs: 10,
      retryMaxMs: 10,
    });

    await expect(fixture.service.initialize()).resolves.toBeUndefined();
    await eventually(() => !fixture.service.getState().available);
    expect(fixture.service.getState().statusMessage).toMatch(
      /Remote radio offline; retrying/u,
    );

    await eventually(
      () =>
        fixture.remote.catalogCalls >= 2 &&
        fixture.service.getState().available &&
        fixture.service.getState().track?.id === "alpha",
    );
    await fixture.service.close();
  });

  it("isolates a persistent music service failure from normal application state", async () => {
    const fixture = await remoteFixture({ catalogFailures: Infinity });

    await expect(fixture.service.initialize()).resolves.toBeUndefined();
    await eventually(() => !fixture.service.getState().available);
    await expect(
      fixture.service.execute({ type: "volume", volume: 21 }),
    ).resolves.toMatchObject({ source: "remote", volume: 21 });
    expect((await fixture.store.load()).music?.volume).toBe(21);
    expect(fixture.backend.initializeCount).toBe(0);
    await fixture.service.close();
  });
});

describe("MusicService local and off sources", () => {
  it("keeps a configured local library working without contacting remote music", async () => {
    const fixture = await localFixture();

    await fixture.service.initialize();
    await fixture.service.execute({ type: "play" });

    expect(fixture.service.getState()).toMatchObject({
      source: "local",
      available: true,
      playing: true,
      trackCount: 2,
    });
    expect(fixture.backend.playlist).toEqual([
      path.join(fixture.library, "Album", "two.flac"),
      path.join(fixture.library, "one.mp3"),
    ]);
    expect(fixture.remote.catalogCalls).toBe(0);
    expect(fixture.remote.nowPlayingCalls).toBe(0);
    await fixture.service.close();
  });

  it("supports music off without starting mpv or contacting remote music", async () => {
    const root = await workspace();
    const store = new ConfigStore(path.join(root, "config.json"));
    await store.updateMusic({ source: "off" });
    const backend = new FakeMusicBackend(false);
    const remote = new FakeRemoteMusicProvider();
    const service = new MusicService({
      configStore: store,
      backend,
      remoteClient: remote,
    });

    await service.initialize();
    const state = await service.execute({ type: "play" });

    expect(state).toMatchObject({
      source: "off",
      playing: false,
      statusMessage: "Music is off. Use /music remote or /music local.",
    });
    expect(backend.initializeCount).toBe(0);
    expect(remote.catalogCalls).toBe(0);
    expect(remote.nowPlayingCalls).toBe(0);
    await service.close();
  });

  it("restores local settings and track without starting mpv", async () => {
    const fixture = await localFixture({
      music: {
        volume: 33,
        shuffle: true,
        repeat: true,
        lastTrack: "Album/two.flac",
        positionSeconds: 14.5,
      },
    });

    await fixture.service.initialize();

    expect(fixture.service.getState()).toMatchObject({
      source: "local",
      track: { id: "Album/two.flac", title: "two" },
      elapsedSeconds: 14.5,
      volume: 33,
      shuffle: true,
      repeat: true,
    });
    expect(fixture.backend.initializeCount).toBe(0);
    await fixture.service.close();
  });

  it("executes local controls and persists settings", async () => {
    const fixture = await localFixture();
    await fixture.service.initialize();

    await fixture.service.execute({ type: "volume", volume: 45 });
    await fixture.service.execute({ type: "shuffle" });
    await fixture.service.execute({ type: "repeat" });
    await fixture.service.execute({ type: "play" });
    await fixture.service.execute({ type: "pause" });
    await fixture.service.execute({ type: "toggle" });
    await fixture.service.execute({ type: "seek", seconds: 9 });
    await fixture.service.execute({ type: "next" });
    await fixture.service.execute({ type: "previous" });
    await fixture.service.execute({ type: "status" });

    expect(fixture.backend.commands).toEqual(
      expect.arrayContaining([
        "initialize",
        "load:0:2",
        "volume:45",
        "shuffle:true",
        "repeat:true",
        "play",
        "pause",
        "seek:9",
        "next",
        "previous",
        "state",
      ]),
    );
    expect((await fixture.store.load()).music).toMatchObject({
      source: "local",
      libraryPath: fixture.library,
      volume: 45,
      shuffle: true,
      repeat: true,
    });
    await fixture.service.close();
  });

  it("switches between remote, local, and off sources", async () => {
    const fixture = await localFixture();
    await fixture.service.initialize();

    await fixture.service.execute({ type: "remote" });
    expect(fixture.service.getState().source).toBe("remote");
    await fixture.service.execute({ type: "local" });
    expect(fixture.service.getState().source).toBe("local");
    await fixture.service.execute({ type: "off" });
    expect(fixture.service.getState().source).toBe("off");
    expect((await fixture.store.load()).music?.source).toBe("off");
    await fixture.service.close();
  });

  it("isolates an unavailable backend while keeping local settings usable", async () => {
    const fixture = await localFixture({ backendUnavailable: true });
    await fixture.service.initialize();

    const unavailable = await fixture.service.execute({ type: "play" });
    expect(unavailable.available).toBe(false);
    expect(unavailable.statusMessage).toMatch(/mpv is unavailable/u);

    const configured = await fixture.service.execute({
      type: "volume",
      volume: 20,
    });
    expect(configured.volume).toBe(20);
    expect((await fixture.store.load()).music?.volume).toBe(20);
    await fixture.service.close();
  });

  it("persists local backend metadata and progress events", async () => {
    const fixture = await localFixture({ progressDebounceMs: 10 });
    await fixture.service.initialize();
    await fixture.service.execute({ type: "play" });

    fixture.backend.emit({
      type: "state",
      state: {
        path: path.join(fixture.library, "one.mp3"),
        title: "One from metadata",
        artist: "Example Artist",
        album: "Example Album",
        elapsedSeconds: 61.25,
        durationSeconds: 120,
        playing: true,
      },
    });
    fixture.backend.emit({ type: "state", state: { elapsedSeconds: 62.5 } });
    await eventually(async () => {
      const music = (await fixture.store.load()).music;
      return music?.lastTrack === "one.mp3" && music.positionSeconds === 62.5;
    });

    expect(fixture.service.getState()).toMatchObject({
      track: {
        id: "one.mp3",
        title: "One from metadata",
        artist: "Example Artist",
      },
      elapsedSeconds: 62.5,
      playing: true,
    });
    await fixture.service.close();
  });

  it("validates commands and publishes immutable snapshots", async () => {
    const fixture = await localFixture();
    const snapshots: Array<ReturnType<MusicService["getState"]>> = [];
    const unsubscribe = fixture.service.subscribe((state) =>
      snapshots.push(state),
    );
    await fixture.service.initialize();

    await expect(
      fixture.service.execute({ type: "volume", volume: 101 }),
    ).rejects.toThrow(/between 0 and 100/u);
    await expect(
      fixture.service.execute({ type: "seek", seconds: -1 }),
    ).rejects.toThrow(/nonnegative/u);
    const snapshot = snapshots.at(-1);
    if (snapshot?.track !== undefined) snapshot.track.title = "mutated";
    expect(fixture.service.getState().track?.title).toBe("two");

    unsubscribe();
    await fixture.service.close();
  });
});

interface Fixture {
  root: string;
  store: ConfigStore;
  backend: FakeMusicBackend;
  remote: FakeRemoteMusicProvider;
  service: MusicService;
}

interface LocalFixture extends Fixture {
  library: string;
}

async function remoteFixture(
  options: {
    catalogFailures?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    driftThresholdSeconds?: number;
    refreshMs?: number;
  } = {},
): Promise<Fixture> {
  const root = await workspace();
  const store = new ConfigStore(path.join(root, "config.json"));
  const backend = new FakeMusicBackend(false);
  const remote = new FakeRemoteMusicProvider();
  remote.catalogFailures = options.catalogFailures ?? 0;
  const service = new MusicService({
    configStore: store,
    backend,
    remoteClient: remote,
    now: () => NOW,
    remoteRefreshMs: options.refreshMs ?? 60_000,
    remoteRetryBaseMs: options.retryBaseMs ?? 60_000,
    remoteRetryMaxMs: options.retryMaxMs ?? 60_000,
    remoteDriftThresholdSeconds: options.driftThresholdSeconds ?? 5,
  });
  return { root, store, backend, remote, service };
}

async function localFixture(
  options: {
    backendUnavailable?: boolean;
    progressDebounceMs?: number;
    music?: {
      volume?: number;
      shuffle?: boolean;
      repeat?: boolean;
      lastTrack?: string;
      positionSeconds?: number;
    };
  } = {},
): Promise<LocalFixture> {
  const root = await workspace();
  const library = path.join(root, "music");
  await mkdir(path.join(library, "Album"), { recursive: true });
  await writeFile(path.join(library, "one.mp3"), "one");
  await writeFile(path.join(library, "Album", "two.flac"), "two");
  const store = new ConfigStore(path.join(root, "config.json"));
  await store.updateMusic({
    source: "local",
    libraryPath: library,
    ...options.music,
  });
  const backend = new FakeMusicBackend(options.backendUnavailable ?? false);
  const remote = new FakeRemoteMusicProvider();
  const service = new MusicService({
    configStore: store,
    backend,
    remoteClient: remote,
    now: () => NOW,
    progressDebounceMs: options.progressDebounceMs ?? 5,
    remoteRefreshMs: 60_000,
  });
  return { root, library, store, backend, remote, service };
}

class FakeRemoteMusicProvider implements RemoteMusicProvider {
  catalog = catalog();
  nowPlaying = nowPlaying(ALPHA_TRACK, 37, BETA_TRACK);
  catalogCalls = 0;
  nowPlayingCalls = 0;
  catalogFailures = 0;

  async getCatalog(): Promise<RemoteCatalog> {
    this.catalogCalls += 1;
    if (this.catalogCalls <= this.catalogFailures) {
      throw new Error("service unavailable");
    }
    return this.catalog;
  }

  async getNowPlaying(): Promise<RemoteNowPlaying> {
    this.nowPlayingCalls += 1;
    return this.nowPlaying;
  }
}

class FakeMusicBackend implements MusicBackend {
  readonly commands: string[] = [];
  initializeCount = 0;
  playlist: string[] = [];
  private readonly listeners = new Set<(event: MusicBackendEvent) => void>();
  private state: MusicBackendState = {
    playing: false,
    elapsedSeconds: 0,
    durationSeconds: 120,
    volume: 70,
    trackIndex: -1,
    trackCount: 0,
  };

  constructor(private readonly unavailable: boolean) {}

  get seekCommands(): number[] {
    return this.commands
      .filter((command) => command.startsWith("seek:"))
      .map((command) => Number(command.slice("seek:".length)));
  }

  setElapsed(seconds: number): void {
    this.state.elapsedSeconds = seconds;
  }

  async initialize(): Promise<void> {
    this.initializeCount += 1;
    this.commands.push("initialize");
    if (this.unavailable) {
      throw new MusicBackendUnavailableError(
        "mpv is unavailable for this test",
      );
    }
  }

  async loadPlaylist(
    paths: readonly string[],
    trackIndex: number,
  ): Promise<void> {
    this.commands.push(`load:${trackIndex}:${paths.length}`);
    this.playlist = [...paths];
    this.state.trackIndex = trackIndex;
    this.state.trackCount = paths.length;
    this.state.path = paths[trackIndex];
  }

  async play(): Promise<void> {
    this.commands.push("play");
    this.state.playing = true;
  }

  async pause(): Promise<void> {
    this.commands.push("pause");
    this.state.playing = false;
  }

  async toggle(): Promise<void> {
    this.commands.push("toggle");
    this.state.playing = !this.state.playing;
  }

  async next(): Promise<void> {
    this.commands.push("next");
    this.state.trackIndex = Math.min(
      this.playlist.length - 1,
      this.state.trackIndex + 1,
    );
    this.state.path = this.playlist[this.state.trackIndex];
    this.state.elapsedSeconds = 0;
  }

  async previous(): Promise<void> {
    this.commands.push("previous");
    this.state.trackIndex = Math.max(0, this.state.trackIndex - 1);
    this.state.path = this.playlist[this.state.trackIndex];
    this.state.elapsedSeconds = 0;
  }

  async seek(seconds: number): Promise<void> {
    this.commands.push(`seek:${seconds}`);
    this.state.elapsedSeconds = seconds;
  }

  async setVolume(volume: number): Promise<void> {
    this.commands.push(`volume:${volume}`);
    this.state.volume = volume;
  }

  async setShuffle(shuffle: boolean): Promise<void> {
    this.commands.push(`shuffle:${shuffle}`);
  }

  async setRepeat(repeat: boolean): Promise<void> {
    this.commands.push(`repeat:${repeat}`);
  }

  async getState(): Promise<MusicBackendState> {
    this.commands.push("state");
    return { ...this.state };
  }

  subscribe(listener: (event: MusicBackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: MusicBackendEvent): void {
    if (event.type === "state") this.state = { ...this.state, ...event.state };
    for (const listener of this.listeners) listener(event);
  }

  async close(): Promise<void> {
    this.commands.push("close");
  }
}

const ALPHA_TRACK: RemoteTrack = {
  id: "alpha",
  title: "Alpha",
  artist: "CC0 Artist",
  durationSeconds: 180,
  audioUrl: "https://music.example.test/alpha.mp3",
  license: {
    name: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
};

const BETA_TRACK: RemoteTrack = {
  ...ALPHA_TRACK,
  id: "beta",
  title: "Beta",
  audioUrl: "https://music.example.test/beta.mp3",
};

function catalog(): RemoteCatalog {
  return {
    version: 1,
    updatedAt: "2026-07-15T11:59:00.000Z",
    tracks: [ALPHA_TRACK, BETA_TRACK],
    station: {
      id: "eulr-focus",
      name: "eulr focus radio",
      trackIds: [ALPHA_TRACK.id, BETA_TRACK.id],
    },
  };
}

function nowPlaying(
  track: RemoteTrack,
  positionSeconds: number,
  nextTrack: RemoteTrack,
): RemoteNowPlaying {
  return {
    station: { id: "eulr-focus", name: "eulr focus radio" },
    track,
    positionSeconds,
    startedAt: "2026-07-15T11:59:00.000Z",
    endsAt: "2026-07-15T12:02:00.000Z",
    nextTrack,
    serverTime: "2026-07-15T12:00:00.000Z",
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "eulr-music-service-"));
  roots.push(root);
  return root;
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
