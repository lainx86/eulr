import { randomBytes } from "node:crypto";
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import {
  createConnection as nodeCreateConnection,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { redactText } from "../auth/redaction.js";
import { CancellationError, isAbortError } from "../utils/errors.js";
import { MusicBackendError, MusicBackendUnavailableError } from "./errors.js";
import type {
  MusicBackend,
  MusicBackendEvent,
  MusicBackendState,
} from "./types.js";

const MAX_FRAME_BUFFER_BYTES = 1024 * 1024;
const OBSERVED_PROPERTIES = [
  "path",
  "time-pos",
  "duration",
  "pause",
  "playlist-pos",
  "playlist-count",
  "volume",
  "metadata",
  "idle-active",
] as const;

type MpvCommandValue = string | number | boolean | null;
type SpawnMpv = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;
type ConnectMpv = (endpoint: string) => Socket;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface PendingFileLoad {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const envelopeSchema = z.looseObject({
  request_id: z.number().int().optional(),
  error: z.string().optional(),
  data: z.unknown().optional(),
  event: z.string().optional(),
  name: z.string().optional(),
  reason: z.string().optional(),
  file_error: z.string().optional(),
});

export interface MpvBackendOptions {
  executable?: string;
  spawn?: SpawnMpv;
  connect?: ConnectMpv;
  platform?: NodeJS.Platform;
  temporaryRoot?: string;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  loadTimeoutMs?: number;
  connectRetryMs?: number;
  shutdownTimeoutMs?: number;
}

export class MpvBackend implements MusicBackend {
  private readonly executable: string;
  private readonly spawnProcess: SpawnMpv;
  private readonly connectSocket: ConnectMpv;
  private readonly platform: NodeJS.Platform;
  private readonly temporaryRoot: string;
  private readonly startupTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly connectRetryMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly listeners = new Set<(event: MusicBackendEvent) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private pendingFileLoad: PendingFileLoad | undefined;
  private child: ChildProcess | undefined;
  private socket: Socket | undefined;
  private endpoint: string | undefined;
  private socketDirectory: string | undefined;
  private initializePromise: Promise<void> | undefined;
  private startupFailure: Error | undefined;
  private receiveBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private closing = false;
  private state: MusicBackendState = {
    playing: false,
    elapsedSeconds: 0,
    durationSeconds: 0,
    volume: 70,
    trackIndex: -1,
    trackCount: 0,
  };

  constructor(options: MpvBackendOptions = {}) {
    this.executable = options.executable ?? "mpv";
    this.spawnProcess = options.spawn ?? nodeSpawn;
    this.connectSocket =
      options.connect ?? ((endpoint) => nodeCreateConnection(endpoint));
    this.platform = options.platform ?? process.platform;
    this.temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 30_000;
    this.connectRetryMs = options.connectRetryMs ?? 25;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 750;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.socket !== undefined && !this.socket.destroyed) return;
    if (this.closing) {
      throw new MusicBackendError("The mpv backend has been closed");
    }
    if (this.initializePromise === undefined) {
      const operation = this.start(signal);
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

  async loadPlaylist(
    paths: readonly string[],
    trackIndex: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (paths.length === 0) {
      throw new MusicBackendError("Cannot load an empty music playlist");
    }
    if (
      !Number.isInteger(trackIndex) ||
      trackIndex < 0 ||
      trackIndex >= paths.length
    ) {
      throw new MusicBackendError(
        `Invalid playlist track index: ${trackIndex}`,
      );
    }
    await this.initialize(signal);
    await this.loadFile(paths[0] ?? "", "replace", signal);
    for (const filePath of paths.slice(1)) {
      await this.send(["loadfile", filePath, "append"], signal);
    }
    if (trackIndex !== 0) {
      const loaded = this.waitForFileLoaded(signal);
      try {
        await this.send(["set_property", "playlist-pos", trackIndex], signal);
        await loaded.promise;
      } catch (error) {
        loaded.cancel();
        throw error;
      }
    }
  }

  async play(signal?: AbortSignal): Promise<void> {
    await this.run(["set_property", "pause", false], signal);
  }

  async pause(signal?: AbortSignal): Promise<void> {
    await this.run(["set_property", "pause", true], signal);
  }

  async toggle(signal?: AbortSignal): Promise<void> {
    await this.run(["cycle", "pause"], signal);
  }

  async next(signal?: AbortSignal): Promise<void> {
    await this.run(["playlist-next", "force"], signal);
  }

  async previous(signal?: AbortSignal): Promise<void> {
    await this.run(["playlist-prev", "force"], signal);
  }

  async seek(seconds: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new MusicBackendError(`Invalid seek position: ${seconds}`);
    }
    await this.run(["seek", seconds, "absolute+exact"], signal);
  }

  async setVolume(volume: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new MusicBackendError(`Invalid music volume: ${volume}`);
    }
    await this.run(["set_property", "volume", volume], signal);
  }

  async setShuffle(shuffle: boolean, signal?: AbortSignal): Promise<void> {
    await this.run(
      [shuffle ? "playlist-shuffle" : "playlist-unshuffle"],
      signal,
    );
  }

  async setRepeat(repeat: boolean, signal?: AbortSignal): Promise<void> {
    await this.run(
      ["set_property", "loop-playlist", repeat ? "inf" : "no"],
      signal,
    );
  }

  async getState(signal?: AbortSignal): Promise<MusicBackendState> {
    await this.initialize(signal);
    const [
      pathValue,
      elapsed,
      duration,
      paused,
      volume,
      index,
      count,
      metadata,
    ] = await Promise.all([
      this.getOptionalProperty("path", undefined, signal),
      this.getOptionalProperty("time-pos", 0, signal),
      this.getOptionalProperty("duration", 0, signal),
      this.getOptionalProperty("pause", true, signal),
      this.getOptionalProperty("volume", this.state.volume, signal),
      this.getOptionalProperty("playlist-pos", -1, signal),
      this.getOptionalProperty("playlist-count", 0, signal),
      this.getOptionalProperty("metadata", undefined, signal),
    ]);
    const tags = musicMetadata(metadata);
    this.state = {
      playing: paused === false,
      ...(typeof pathValue === "string" ? { path: pathValue } : {}),
      title: tags.title,
      artist: tags.artist,
      album: tags.album,
      elapsedSeconds: finiteNumber(elapsed, 0),
      durationSeconds: finiteNumber(duration, 0),
      volume: finiteNumber(volume, this.state.volume),
      trackIndex: integerNumber(index, -1),
      trackCount: integerNumber(count, 0),
    };
    return { ...this.state };
  }

  subscribe(listener: (event: MusicBackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const closedError = new MusicBackendError("The mpv backend was closed");
    this.rejectPending(closedError);
    this.rejectPendingFileLoad(closedError);

    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) socket.destroy();

    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGTERM");
      const exited = await waitForExit(child, this.shutdownTimeoutMs);
      if (!exited && child.exitCode === null) child.kill("SIGKILL");
    }

    await this.removeSocketDirectory();
  }

  private async start(signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    this.startupFailure = undefined;
    await this.createEndpoint();
    const endpoint = this.endpoint;
    if (endpoint === undefined) {
      throw new MusicBackendError("Unable to allocate an mpv IPC endpoint");
    }

    try {
      const child = this.spawnProcess(
        this.executable,
        [
          "--idle=yes",
          "--no-terminal",
          "--really-quiet",
          "--audio-display=no",
          `--input-ipc-server=${endpoint}`,
        ],
        { stdio: "ignore", windowsHide: true, shell: false },
      );
      this.child = child;
      child.once("error", (error) => this.handleChildError(error));
      child.once("exit", (code, exitSignal) =>
        this.handleChildExit(code, exitSignal),
      );

      const socket = await this.waitForConnection(endpoint, signal);
      this.attachSocket(socket);
      for (let index = 0; index < OBSERVED_PROPERTIES.length; index += 1) {
        await this.send(
          ["observe_property", index + 1, OBSERVED_PROPERTIES[index] ?? ""],
          signal,
        );
      }
    } catch (error) {
      await this.cleanupFailedStart();
      throw normalizeBackendError(error);
    }
  }

  private async createEndpoint(): Promise<void> {
    const suffix = randomBytes(10).toString("hex");
    if (this.platform === "win32") {
      this.endpoint = `\\\\.\\pipe\\eulr-mpv-${process.pid}-${suffix}`;
      return;
    }
    const directory = await mkdtemp(path.join(this.temporaryRoot, "eulr-mpv-"));
    await chmod(directory, 0o700);
    this.socketDirectory = directory;
    this.endpoint = path.join(directory, "ipc.sock");
  }

  private async waitForConnection(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<Socket> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      throwIfCancelled(signal);
      if (this.startupFailure !== undefined) throw this.startupFailure;
      try {
        return await this.connectOnce(endpoint, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
      }
      await abortableDelay(this.connectRetryMs, signal);
    }
    throw new MusicBackendUnavailableError(
      `Timed out connecting to mpv IPC at ${endpoint}`,
      { cause: lastError },
    );
  }

  private connectOnce(endpoint: string, signal?: AbortSignal): Promise<Socket> {
    return new Promise((resolve, reject) => {
      let socket: Socket;
      try {
        socket = this.connectSocket(endpoint);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const cleanup = (): void => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onConnect = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(socket);
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(
          new CancellationError("Connecting to mpv was cancelled", {
            cause: signal?.reason,
          }),
        );
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.receiveBuffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error) => this.handleSocketFailure(error));
    socket.on("close", () => {
      if (!this.closing && this.socket === socket) {
        this.handleSocketFailure(
          new MusicBackendUnavailableError("The mpv IPC connection closed"),
        );
      }
    });
  }

  private handleData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    if (this.receiveBuffer.length > MAX_FRAME_BUFFER_BYTES) {
      this.handleSocketFailure(
        new MusicBackendError("mpv IPC response exceeded the framing limit"),
      );
      return;
    }

    while (true) {
      const newline = this.receiveBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const frame = this.receiveBuffer.subarray(0, newline).toString("utf8");
      this.receiveBuffer = this.receiveBuffer.subarray(newline + 1);
      if (frame.trim() === "") continue;
      try {
        this.handleEnvelope(envelopeSchema.parse(JSON.parse(frame)));
      } catch (error) {
        this.handleSocketFailure(
          new MusicBackendError("mpv sent an invalid JSON IPC response", {
            cause: error,
          }),
        );
        return;
      }
    }
  }

  private handleEnvelope(envelope: z.infer<typeof envelopeSchema>): void {
    if (envelope.event !== undefined) {
      this.handleMpvEvent(envelope);
      return;
    }
    const requestId = envelope.request_id;
    if (requestId === undefined) return;
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    cleanupPending(pending);
    if (envelope.error !== "success") {
      pending.reject(
        new MusicBackendError(
          `mpv command failed: ${redactText(envelope.error ?? "unknown error")}`,
        ),
      );
      return;
    }
    pending.resolve(envelope.data);
  }

  private handleMpvEvent(envelope: z.infer<typeof envelopeSchema>): void {
    if (envelope.event === "file-loaded") {
      this.resolvePendingFileLoad();
      return;
    }
    if (envelope.event === "end-file") {
      if (envelope.reason === "error") {
        this.rejectPendingFileLoad(
          new MusicBackendError(
            `mpv could not load the track${envelope.file_error === undefined ? "" : `: ${redactText(envelope.file_error)}`}`,
          ),
        );
      }
      if (envelope.reason !== "eof") return;
      const update: Partial<MusicBackendState> = {
        elapsedSeconds: 0,
        durationSeconds: 0,
      };
      this.state = { ...this.state, ...update };
      this.emit({ type: "state", state: update });
      this.emit({ type: "ended" });
      return;
    }
    if (envelope.event !== "property-change" || envelope.name === undefined) {
      return;
    }
    const update: Partial<MusicBackendState> = {};
    switch (envelope.name) {
      case "path":
        if (typeof envelope.data === "string") update.path = envelope.data;
        break;
      case "time-pos":
        if (typeof envelope.data === "number")
          update.elapsedSeconds = Math.max(0, envelope.data);
        break;
      case "duration":
        if (typeof envelope.data === "number")
          update.durationSeconds = Math.max(0, envelope.data);
        break;
      case "pause":
        if (typeof envelope.data === "boolean") update.playing = !envelope.data;
        break;
      case "playlist-pos":
        if (typeof envelope.data === "number")
          update.trackIndex = Math.trunc(envelope.data);
        break;
      case "playlist-count":
        if (typeof envelope.data === "number")
          update.trackCount = Math.max(0, Math.trunc(envelope.data));
        break;
      case "volume":
        if (typeof envelope.data === "number")
          update.volume = Math.max(0, Math.min(100, envelope.data));
        break;
      case "metadata": {
        const tags = musicMetadata(envelope.data);
        update.title = tags.title;
        update.artist = tags.artist;
        update.album = tags.album;
        break;
      }
      case "idle-active":
        if (envelope.data === true) update.playing = false;
        break;
    }
    if (Object.keys(update).length === 0) return;
    this.state = { ...this.state, ...update };
    this.emit({ type: "state", state: update });
  }

  private async run(
    command: readonly MpvCommandValue[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.initialize(signal);
    await this.send(command, signal);
  }

  private async loadFile(
    location: string,
    mode: "replace" | "append",
    signal?: AbortSignal,
  ): Promise<void> {
    if (mode === "append") {
      await this.send(["loadfile", location, mode], signal);
      return;
    }
    const loaded = this.waitForFileLoaded(signal);
    try {
      await this.send(["loadfile", location, mode], signal);
      await loaded.promise;
    } catch (error) {
      loaded.cancel();
      throw error;
    }
  }

  private waitForFileLoaded(signal?: AbortSignal): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    throwIfCancelled(signal);
    this.rejectPendingFileLoad(
      new MusicBackendError("A newer mpv track load replaced this request"),
    );
    let pending!: PendingFileLoad;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingFileLoad !== pending) return;
        this.pendingFileLoad = undefined;
        cleanupPendingFileLoad(pending);
        reject(
          new MusicBackendError(
            `mpv track load timed out after ${this.loadTimeoutMs} ms`,
          ),
        );
      }, this.loadTimeoutMs);
      timer.unref();
      pending = { resolve, reject, timer, signal };
      if (signal !== undefined) {
        pending.onAbort = () => {
          if (this.pendingFileLoad !== pending) return;
          this.pendingFileLoad = undefined;
          cleanupPendingFileLoad(pending);
          reject(
            new CancellationError("mpv track load cancelled", {
              cause: signal.reason,
            }),
          );
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pendingFileLoad = pending;
    });
    void promise.catch(() => undefined);
    return {
      promise,
      cancel: () => {
        if (this.pendingFileLoad !== pending) return;
        this.pendingFileLoad = undefined;
        cleanupPendingFileLoad(pending);
        pending.resolve();
      },
    };
  }

  private resolvePendingFileLoad(): void {
    const pending = this.pendingFileLoad;
    if (pending === undefined) return;
    this.pendingFileLoad = undefined;
    cleanupPendingFileLoad(pending);
    pending.resolve();
  }

  private rejectPendingFileLoad(error: unknown): void {
    const pending = this.pendingFileLoad;
    if (pending === undefined) return;
    this.pendingFileLoad = undefined;
    cleanupPendingFileLoad(pending);
    pending.reject(error);
  }

  private async send(
    command: readonly MpvCommandValue[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfCancelled(signal);
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new MusicBackendUnavailableError("mpv IPC is not connected");
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.pending.delete(requestId);
        cleanupPending(pending);
        reject(
          new MusicBackendError(
            `mpv command timed out after ${this.commandTimeoutMs} ms`,
          ),
        );
      }, this.commandTimeoutMs);
      timer.unref();
      const pending: PendingRequest = { resolve, reject, timer, signal };
      if (signal !== undefined) {
        pending.onAbort = () => {
          if (!this.pending.delete(requestId)) return;
          cleanupPending(pending);
          reject(
            new CancellationError("mpv command cancelled", {
              cause: signal.reason,
            }),
          );
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(requestId, pending);
      const payload = `${JSON.stringify({ command, request_id: requestId })}\n`;
      socket.write(payload, (error) => {
        if (error === null || error === undefined) return;
        if (!this.pending.delete(requestId)) return;
        cleanupPending(pending);
        reject(
          new MusicBackendError("Unable to write to mpv IPC", { cause: error }),
        );
      });
    });
  }

  private async getOptionalProperty(
    property: string,
    fallback: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.send(["get_property", property], signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof MusicBackendUnavailableError) throw error;
      return fallback;
    }
  }

  private handleChildError(error: Error): void {
    const normalized = normalizeBackendError(error);
    this.startupFailure = normalized;
    if (this.socket !== undefined) this.handleSocketFailure(normalized);
  }

  private handleChildExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.closing) return;
    const error = new MusicBackendUnavailableError(
      `mpv exited unexpectedly (${code === null ? (signal ?? "unknown") : `code ${code}`})`,
    );
    this.startupFailure = error;
    if (this.socket !== undefined) this.handleSocketFailure(error);
  }

  private handleSocketFailure(error: unknown): void {
    const normalized = normalizeBackendError(error);
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.rejectPending(normalized);
    this.rejectPendingFileLoad(normalized);
    this.emit({ type: "unavailable", message: redactText(normalized.message) });
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      cleanupPending(pending);
      pending.reject(error);
    }
  }

  private emit(event: MusicBackendEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A UI listener must not break the IPC transport.
      }
    }
  }

  private async cleanupFailedStart(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null) child.kill("SIGTERM");
    await this.removeSocketDirectory();
  }

  private async removeSocketDirectory(): Promise<void> {
    const directory = this.socketDirectory;
    this.socketDirectory = undefined;
    this.endpoint = undefined;
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

function cleanupPending(pending: PendingRequest): void {
  clearTimeout(pending.timer);
  if (pending.onAbort !== undefined) {
    pending.signal?.removeEventListener("abort", pending.onAbort);
  }
}

function cleanupPendingFileLoad(pending: PendingFileLoad): void {
  clearTimeout(pending.timer);
  if (pending.onAbort !== undefined) {
    pending.signal?.removeEventListener("abort", pending.onAbort);
  }
}

function normalizeBackendError(error: unknown): MusicBackendError {
  if (error instanceof MusicBackendError) return error;
  if (isAbortError(error)) {
    return error as CancellationError;
  }
  if (isNodeError(error) && error.code === "ENOENT") {
    return new MusicBackendUnavailableError(
      "mpv is not installed or is not available on PATH",
      { cause: error },
    );
  }
  return new MusicBackendUnavailableError(
    `Unable to communicate with mpv: ${redactText(error instanceof Error ? error.message : String(error))}`,
    { cause: error },
  );
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CancellationError("mpv operation cancelled", {
      cause: signal.reason,
    });
  }
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new CancellationError("mpv startup cancelled", {
          cause: signal.reason,
        }),
      );
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new CancellationError("mpv startup cancelled", {
          cause: signal?.reason,
        }),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function integerNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function musicMetadata(value: unknown): {
  title?: string;
  artist?: string;
  album?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const tags = Object.fromEntries(
    Object.entries(value).map(([key, tag]) => [key.toLowerCase(), tag]),
  );
  return {
    ...metadataTag(tags.title, "title"),
    ...metadataTag(tags.artist, "artist"),
    ...metadataTag(tags.album, "album"),
  };
}

function metadataTag(
  value: unknown,
  name: "title" | "artist" | "album",
): Partial<Record<"title" | "artist" | "album", string>> {
  if (typeof value !== "string") return {};
  const normalized = value.trim();
  return normalized === "" ? {} : { [name]: normalized };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
