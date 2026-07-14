import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../src/config/config-store.js";
import { MusicBackendUnavailableError } from "../../src/music/errors.js";
import { MusicService } from "../../src/music/music-service.js";
import type {
  MusicBackend,
  MusicBackendEvent,
  MusicBackendState,
} from "../../src/music/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MusicService", () => {
  it("restores persisted settings and track without starting mpv", async () => {
    const fixture = await musicFixture();
    await fixture.store.updateMusic({
      libraryPath: fixture.library,
      volume: 33,
      shuffle: true,
      repeat: true,
      lastTrack: "Album/two.flac",
      positionSeconds: 14.5,
    });

    await fixture.service.initialize();

    expect(fixture.service.getState()).toMatchObject({
      available: true,
      playing: false,
      track: { id: "Album/two.flac", title: "two" },
      elapsedSeconds: 14.5,
      volume: 33,
      shuffle: true,
      repeat: true,
      trackIndex: 0,
      trackCount: 2,
    });
    expect(fixture.backend.initializeCount).toBe(0);
    await fixture.service.close();
  });

  it("executes the complete fixed command set and persists settings", async () => {
    const fixture = await musicFixture();
    await fixture.service.initialize();

    await fixture.service.execute({ type: "library", path: fixture.library });
    await fixture.service.execute({ type: "volume", volume: 45 });
    await fixture.service.execute({ type: "shuffle" });
    await fixture.service.execute({ type: "repeat" });
    await fixture.service.execute({ type: "play" });
    await fixture.service.execute({ type: "pause" });
    await fixture.service.execute({ type: "toggle" });
    await fixture.service.execute({ type: "seek", seconds: 9 });
    await fixture.service.execute({ type: "next" });
    expect(fixture.service.getState().track?.id).toBe("one.mp3");
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
        "toggle",
        "seek:9",
        "next",
        "previous",
        "state",
      ]),
    );
    expect((await fixture.store.load()).music).toMatchObject({
      libraryPath: fixture.library,
      volume: 45,
      shuffle: true,
      repeat: true,
      lastTrack: "Album/two.flac",
      positionSeconds: 0,
    });
    await fixture.service.close();
  });

  it("isolates an unavailable backend while keeping library and settings usable", async () => {
    const fixture = await musicFixture({ backendUnavailable: true });
    await fixture.service.initialize();
    await fixture.service.execute({ type: "library", path: fixture.library });

    const unavailable = await fixture.service.execute({ type: "play" });
    expect(unavailable.available).toBe(false);
    expect(unavailable.playing).toBe(false);
    expect(unavailable.statusMessage).toMatch(/mpv is unavailable/u);

    const configured = await fixture.service.execute({
      type: "volume",
      volume: 20,
    });
    expect(configured.volume).toBe(20);
    expect(configured.available).toBe(false);
    expect((await fixture.store.load()).music?.volume).toBe(20);
    expect(fixture.backend.initializeCount).toBe(1);
    await fixture.service.close();
  });

  it("persists backend track and progress events after a short debounce", async () => {
    const fixture = await musicFixture({ progressDebounceMs: 10 });
    await fixture.service.initialize();
    await fixture.service.execute({ type: "library", path: fixture.library });
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
    await eventually(async () => {
      const music = (await fixture.store.load()).music;
      return music?.lastTrack === "one.mp3" && music.positionSeconds === 0;
    });
    fixture.backend.emit({
      type: "state",
      state: { elapsedSeconds: 62.5 },
    });
    await eventually(
      async () =>
        ((await fixture.store.load()).music?.positionSeconds ?? 0) >= 62.5,
    );

    expect(fixture.service.getState()).toMatchObject({
      track: {
        id: "one.mp3",
        title: "One from metadata",
        artist: "Example Artist",
        album: "Example Album",
      },
      elapsedSeconds: 62.5,
      durationSeconds: 120,
      playing: true,
    });
    await fixture.service.close();
  });

  it("validates commands at the service boundary", async () => {
    const fixture = await musicFixture();
    await fixture.service.initialize();

    await expect(
      fixture.service.execute({ type: "volume", volume: 101 }),
    ).rejects.toThrow(/between 0 and 100/u);
    await expect(
      fixture.service.execute({ type: "seek", seconds: -1 }),
    ).rejects.toThrow(/nonnegative/u);
    await fixture.service.close();
  });

  it("publishes immutable state snapshots to subscribers", async () => {
    const fixture = await musicFixture();
    const snapshots: Array<ReturnType<MusicService["getState"]>> = [];
    const unsubscribe = fixture.service.subscribe((state) =>
      snapshots.push(state),
    );

    await fixture.service.initialize();
    await fixture.service.execute({ type: "library", path: fixture.library });
    const snapshot = snapshots.at(-1);
    if (snapshot?.track !== undefined) snapshot.track.title = "mutated";

    expect(fixture.service.getState().track?.title).toBe("two");
    unsubscribe();
    await fixture.service.close();
  });
});

interface Fixture {
  root: string;
  library: string;
  store: ConfigStore;
  backend: FakeMusicBackend;
  service: MusicService;
}

async function musicFixture(
  options: {
    backendUnavailable?: boolean;
    progressDebounceMs?: number;
  } = {},
): Promise<Fixture> {
  const root = await workspace();
  const library = path.join(root, "music");
  await mkdir(path.join(library, "Album"), { recursive: true });
  await writeFile(path.join(library, "one.mp3"), "one");
  await writeFile(path.join(library, "Album", "two.flac"), "two");
  const store = new ConfigStore(path.join(root, "config.json"));
  const backend = new FakeMusicBackend(options.backendUnavailable ?? false);
  const service = new MusicService({
    configStore: store,
    backend,
    progressDebounceMs: options.progressDebounceMs ?? 5,
  });
  return { root, library, store, backend, service };
}

class FakeMusicBackend implements MusicBackend {
  readonly commands: string[] = [];
  initializeCount = 0;
  private readonly listeners = new Set<(event: MusicBackendEvent) => void>();
  private playlist: string[] = [];
  private state: MusicBackendState = {
    playing: false,
    elapsedSeconds: 0,
    durationSeconds: 120,
    volume: 70,
    trackIndex: -1,
    trackCount: 0,
  };

  constructor(private readonly unavailable: boolean) {}

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
    for (const listener of this.listeners) listener(event);
    if (event.type === "state") this.state = { ...this.state, ...event.state };
  }

  async close(): Promise<void> {
    this.commands.push("close");
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "eulr-music-service-"));
  roots.push(root);
  return root;
}

async function eventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
