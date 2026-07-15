import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  MpvBackend,
  type MpvBackendOptions,
} from "../../src/music/mpv-backend.js";
import { MusicBackendUnavailableError } from "../../src/music/errors.js";
import { CancellationError } from "../../src/utils/errors.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MpvBackend", () => {
  it("correlates fragmented JSON replies, emits state, and cleans private IPC files", async () => {
    const root = await workspace();
    const backend = backendWithPeer(root, "normal");
    const events: unknown[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.initialize();
    if (process.platform !== "win32") {
      const [directory] = await readdir(root);
      expect(directory).toBeDefined();
      expect((await stat(path.join(root, directory ?? ""))).mode & 0o777).toBe(
        0o700,
      );
    }

    await backend.loadPlaylist(["/music/one.mp3", "/music/two.mp3"], 1);
    await backend.setVolume(42);
    await backend.seek(12.5);
    await backend.play();
    const state = await backend.getState();

    expect(state).toMatchObject({
      playing: true,
      path: "/music/two.mp3",
      title: "two",
      artist: "Test Artist",
      album: "Test Album",
      elapsedSeconds: 12.5,
      durationSeconds: 180,
      volume: 42,
      trackIndex: 1,
      trackCount: 2,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "state",
          state: expect.objectContaining({ playing: true }),
        }),
      ]),
    );

    await backend.previous();
    await backend.seek(40);
    await backend.next();
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "state",
          state: { elapsedSeconds: 0, durationSeconds: 0 },
        },
        expect.objectContaining({
          type: "state",
          state: expect.objectContaining({ path: "/music/two.mp3" }),
        }),
      ]),
    );

    await backend.close();
    if (process.platform !== "win32") expect(await readdir(root)).toEqual([]);
  });

  it("surfaces mpv command errors", async () => {
    const backend = backendWithPeer(await workspace(), "error-volume");
    try {
      await backend.initialize();
      await expect(backend.setVolume(50)).rejects.toThrow(/command failed/u);
    } finally {
      await backend.close();
    }
  });

  it("supports cancellation of an in-flight command", async () => {
    const backend = backendWithPeer(await workspace(), "hang-toggle", {
      commandTimeoutMs: 2_000,
    });
    try {
      await backend.initialize();
      const controller = new AbortController();
      const operation = backend.toggle(controller.signal);
      controller.abort(new Error("cancel"));
      await expect(operation).rejects.toBeInstanceOf(CancellationError);
    } finally {
      await backend.close();
    }
  });

  it("times out commands that never receive a response", async () => {
    const backend = backendWithPeer(await workspace(), "hang-toggle", {
      commandTimeoutMs: 30,
    });
    try {
      await backend.initialize();
      await expect(backend.toggle()).rejects.toThrow(/timed out/u);
    } finally {
      await backend.close();
    }
  });

  it("waits for a remote stream to load before seeking", async () => {
    const backend = backendWithPeer(await workspace(), "delayed-load", {
      loadTimeoutMs: 500,
    });
    try {
      await backend.initialize();
      await backend.loadPlaylist(["https://music.example.test/track.mp3"], 0);
      await expect(backend.seek(42)).resolves.toBeUndefined();
      await expect(backend.getState()).resolves.toMatchObject({
        path: "https://music.example.test/track.mp3",
        elapsedSeconds: 42,
      });
    } finally {
      await backend.close();
    }
  });

  it("does not report an internal stream replacement as a completed track", async () => {
    const backend = backendWithPeer(await workspace(), "normal");
    const events: unknown[] = [];
    backend.subscribe((event) => events.push(event));
    try {
      await backend.initialize();
      await backend.loadPlaylist(["https://music.example.test/one.mp3"], 0);
      await backend.loadPlaylist(["https://music.example.test/two.mp3"], 0);
      expect(events).not.toContainEqual({ type: "ended" });
    } finally {
      await backend.close();
    }
  });

  it("normalizes a missing mpv executable as unavailable", async () => {
    const backend = new MpvBackend({
      executable: path.join(await workspace(), "definitely-missing-eulr-mpv"),
      startupTimeoutMs: 300,
      connectRetryMs: 5,
      temporaryRoot: await workspace(),
    });

    await expect(backend.initialize()).rejects.toBeInstanceOf(
      MusicBackendUnavailableError,
    );
    await backend.close();
  });
});

function backendWithPeer(
  temporaryRoot: string,
  mode: string,
  overrides: Partial<MpvBackendOptions> = {},
): MpvBackend {
  return new MpvBackend({
    spawn: () => fakeProcess(),
    connect: () => new FakeMpvSocket(mode) as unknown as Socket,
    temporaryRoot,
    startupTimeoutMs: 500,
    connectRetryMs: 5,
    commandTimeoutMs: 500,
    shutdownTimeoutMs: 25,
    ...overrides,
  });
}

interface RequestEnvelope {
  command: Array<string | number | boolean | null>;
  request_id: number;
}

class FakeMpvSocket extends Duplex {
  private input = "";
  private outputTail: Promise<void> = Promise.resolve();
  private playlist: string[] = [];
  private fileLoaded = true;
  private readonly properties: Record<string, unknown> = {
    path: undefined,
    "time-pos": 0,
    duration: 180,
    pause: true,
    "playlist-pos": -1,
    "playlist-count": 0,
    volume: 70,
    metadata: undefined,
    "idle-active": false,
  };

  constructor(private readonly mode: string) {
    super();
    queueMicrotask(() => this.emit("connect"));
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.input += chunk.toString("utf8");
    while (this.input.includes("\n")) {
      const newline = this.input.indexOf("\n");
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      if (line.trim()) this.handleRequest(JSON.parse(line) as RequestEnvelope);
    }
    callback();
  }

  private handleRequest(request: RequestEnvelope): void {
    const [name, first, second] = request.command;
    if (this.mode === "hang-toggle" && name === "cycle") return;
    if (
      this.mode === "error-volume" &&
      name === "set_property" &&
      first === "volume"
    ) {
      this.send({
        request_id: request.request_id,
        error: "property unavailable",
      });
      return;
    }
    let data: unknown = null;
    if (name === "observe_property" && typeof second === "string") {
      this.propertyEvent(second);
    } else if (name === "loadfile" && typeof first === "string") {
      const replacingCurrent = second === "replace" && this.playlist.length > 0;
      if (replacingCurrent) this.send({ event: "end-file", reason: "stop" });
      if (second === "replace") this.playlist = [first];
      else this.playlist.push(first);
      this.properties["playlist-count"] = this.playlist.length;
      if ((this.properties["playlist-pos"] as number) < 0)
        this.properties["playlist-pos"] = 0;
      this.updateCurrentTrack();
      if (second === "replace") this.announceFileLoaded();
    } else if (name === "set_property" && typeof first === "string") {
      this.properties[first] = second;
      if (first === "playlist-pos" && typeof second === "number") {
        this.updateCurrentTrack();
        this.propertyEvent("path");
        this.propertyEvent("metadata");
        this.announceFileLoaded();
      }
      this.propertyEvent(first);
    } else if (name === "cycle" && first === "pause") {
      this.properties.pause = !this.properties.pause;
      this.propertyEvent("pause");
    } else if (name === "seek" && typeof first === "number") {
      if (!this.fileLoaded) {
        this.send({
          request_id: request.request_id,
          error: "error running command",
        });
        return;
      }
      this.properties["time-pos"] = first;
      this.propertyEvent("time-pos");
    } else if (name === "playlist-next") {
      this.movePlaylist(1);
    } else if (name === "playlist-prev") {
      this.movePlaylist(-1);
    } else if (name === "get_property" && typeof first === "string") {
      data = this.properties[first];
      if (data === undefined) {
        this.send({
          request_id: request.request_id,
          error: "property unavailable",
        });
        return;
      }
    }
    this.send({ request_id: request.request_id, error: "success", data });
  }

  private announceFileLoaded(): void {
    this.fileLoaded = false;
    const publish = (): void => {
      this.fileLoaded = true;
      this.send({ event: "file-loaded" });
    };
    if (this.mode === "delayed-load") setTimeout(publish, 20);
    else publish();
  }

  private movePlaylist(offset: number): void {
    this.send({ event: "end-file", reason: "eof" });
    const current = this.properties["playlist-pos"] as number;
    const next = Math.max(
      0,
      Math.min(this.playlist.length - 1, current + offset),
    );
    this.properties["playlist-pos"] = next;
    this.properties["time-pos"] = 0;
    this.updateCurrentTrack();
    this.propertyEvent("playlist-pos");
    this.propertyEvent("path");
    this.propertyEvent("metadata");
  }

  private updateCurrentTrack(): void {
    const trackPath = this.playlist[this.properties["playlist-pos"] as number];
    this.properties.path = trackPath;
    const title =
      trackPath === undefined
        ? undefined
        : path.basename(trackPath, path.extname(trackPath));
    this.properties.metadata =
      title === undefined
        ? undefined
        : {
            TITLE: title,
            Artist: "Test Artist",
            album: "Test Album",
          };
  }

  private propertyEvent(name: string): void {
    this.send({
      event: "property-change",
      name,
      data: this.properties[name],
    });
  }

  private send(message: Record<string, unknown>): void {
    const line = `${JSON.stringify(message)}\n`;
    const middle = Math.max(1, Math.floor(line.length / 2));
    this.outputTail = this.outputTail.then(
      () =>
        new Promise((resolve) => {
          this.push(line.slice(0, middle));
          setTimeout(() => {
            this.push(line.slice(middle));
            resolve();
          }, 1);
        }),
    );
  }
}

function fakeProcess(): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  Object.defineProperty(process, "exitCode", {
    value: null,
    writable: true,
    configurable: true,
  });
  process.kill = (() => {
    Object.defineProperty(process, "exitCode", {
      value: 0,
      writable: true,
      configurable: true,
    });
    queueMicrotask(() => process.emit("exit", 0, null));
    return true;
  }) as ChildProcess["kill"];
  return process;
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "eulr-mpv-test-"));
  roots.push(root);
  return root;
}
