import { z } from "zod";

import { redactText } from "../auth/redaction.js";
import { CancellationError } from "../utils/errors.js";
import { MusicError } from "./errors.js";

export const DEFAULT_MUSIC_SERVICE_URL =
  "https://eulr-music-service.vercel.app";
export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

const dateTimeSchema = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Expected an ISO date-time",
  );
const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Expected an HTTP(S) URL");

export const remoteTrackSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1).optional(),
  durationSeconds: z.number().finite().positive(),
  audioUrl: httpUrlSchema,
  license: z.object({
    name: z.string().min(1),
    url: httpUrlSchema,
  }),
});

const stationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const remoteCatalogSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: dateTimeSchema,
  tracks: z.array(remoteTrackSchema),
  station: stationSchema.extend({ trackIds: z.array(z.string().min(1)) }),
});

export const nowPlayingSchema = z.object({
  station: stationSchema,
  track: remoteTrackSchema,
  positionSeconds: z.number().finite().nonnegative(),
  startedAt: dateTimeSchema,
  endsAt: dateTimeSchema,
  nextTrack: remoteTrackSchema,
  serverTime: dateTimeSchema,
});

export type RemoteTrack = z.infer<typeof remoteTrackSchema>;
export type RemoteCatalog = z.infer<typeof remoteCatalogSchema>;
export type RemoteNowPlaying = z.infer<typeof nowPlayingSchema>;

export interface RemoteMusicProvider {
  getCatalog(signal?: AbortSignal): Promise<RemoteCatalog>;
  getNowPlaying(signal?: AbortSignal): Promise<RemoteNowPlaying>;
}

export interface RemoteMusicClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class RemoteMusicClient implements RemoteMusicProvider {
  readonly baseUrl: string;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RemoteMusicClientOptions = {}) {
    this.baseUrl = normalizeServiceUrl(
      options.baseUrl ?? DEFAULT_MUSIC_SERVICE_URL,
    );
    this.request = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
  }

  getCatalog(signal?: AbortSignal): Promise<RemoteCatalog> {
    return this.get("api/v1/catalog", remoteCatalogSchema, signal);
  }

  getNowPlaying(signal?: AbortSignal): Promise<RemoteNowPlaying> {
    return this.get("api/v1/now-playing", nowPlayingSchema, signal);
  }

  private async get<T>(
    pathname: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new CancellationError("Remote music request cancelled", {
        cause: signal.reason,
      });
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, this.timeoutMs);
    timer.unref();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      let response: Response;
      try {
        response = await this.request(new URL(pathname, `${this.baseUrl}/`), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new CancellationError("Remote music request cancelled", {
            cause: error,
          });
        }
        if (timedOut) {
          throw new MusicError(
            `Remote music request timed out after ${this.timeoutMs} ms`,
            { cause: error },
          );
        }
        throw new MusicError("Unable to connect to the remote music service", {
          cause: error,
        });
      }

      const body = await response.text();
      if (!response.ok) {
        throw new MusicError(
          `Remote music service returned HTTP ${response.status}: ${responseSummary(body)}`,
        );
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(body) as unknown;
      } catch (error) {
        throw new MusicError("Remote music service returned invalid JSON", {
          cause: error,
        });
      }
      const parsed = schema.safeParse(decoded);
      if (!parsed.success) {
        throw new MusicError(
          `Remote music response failed validation: ${parsed.error.issues[0]?.message ?? "invalid response"}`,
          { cause: parsed.error },
        );
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function resolveMusicServiceUrl(
  configuredUrl: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const environmentUrl = environment.EULR_MUSIC_SERVICE_URL?.trim();
  return normalizeServiceUrl(
    environmentUrl || configuredUrl || DEFAULT_MUSIC_SERVICE_URL,
  );
}

export function synchronizedPositionSeconds(
  nowPlaying: RemoteNowPlaying,
  now = Date.now(),
): number {
  const serverTime = Date.parse(nowPlaying.serverTime);
  const transitSeconds = Math.max(0, (now - serverTime) / 1_000);
  return Math.min(
    nowPlaying.track.durationSeconds,
    Math.max(0, nowPlaying.positionSeconds + transitSeconds),
  );
}

function normalizeServiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new MusicError(
      `Invalid remote music service URL: ${redactText(value)}`,
      {
        cause: error,
      },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MusicError("Remote music service URL must use HTTP or HTTPS");
  }
  return url.toString().replace(/\/+$/u, "");
}

function responseSummary(body: string): string {
  const compact = redactText(body.replace(/\s+/gu, " ").trim());
  if (compact === "") return "empty response body";
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
}
