import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MUSIC_SERVICE_URL,
  RemoteMusicClient,
  nowPlayingSchema,
  resolveMusicServiceUrl,
  synchronizedPositionSeconds,
} from "../../src/music/remote-music-client.js";

describe("RemoteMusicClient", () => {
  it("parses the now-playing response contract", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(nowPlayingPayload()));
    const client = new RemoteMusicClient({
      baseUrl: "https://radio.example.test/root/",
      fetch: request,
    });

    const result = await client.getNowPlaying();

    expect(result).toMatchObject({
      station: { id: "eulr-focus", name: "eulr focus radio" },
      track: {
        id: "bubbles",
        title: "Bubbles",
        audioUrl: "https://cdn.example.test/bubbles.mp3",
      },
      positionSeconds: 70.623,
    });
    expect(request.mock.calls[0]?.[0].toString()).toBe(
      "https://radio.example.test/root/api/v1/now-playing",
    );
  });

  it("parses the catalog response contract", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        version: 11,
        updatedAt: "2026-07-15T11:00:00.000Z",
        tracks: [remoteTrackPayload()],
        station: {
          id: "eulr-focus",
          name: "eulr focus radio",
          trackIds: ["bubbles"],
        },
      }),
    );
    const client = new RemoteMusicClient({ fetch: request });

    await expect(client.getCatalog()).resolves.toMatchObject({
      version: 11,
      tracks: [{ id: "bubbles" }],
      station: { trackIds: ["bubbles"] },
    });
  });

  it("uses environment, config, then the public default URL", () => {
    expect(
      resolveMusicServiceUrl("https://config.example.test/", {
        EULR_MUSIC_SERVICE_URL: "https://env.example.test///",
      }),
    ).toBe("https://env.example.test");
    expect(resolveMusicServiceUrl("https://config.example.test/", {})).toBe(
      "https://config.example.test",
    );
    expect(resolveMusicServiceUrl(undefined, {})).toBe(
      DEFAULT_MUSIC_SERVICE_URL,
    );
  });

  it("accounts for request transit time when calculating radio position", () => {
    const parsed = nowPlayingSchema.parse(nowPlayingPayload());
    expect(
      synchronizedPositionSeconds(
        parsed,
        Date.parse("2026-07-15T12:00:02.000Z"),
      ),
    ).toBeCloseTo(72.623);
  });

  it("reports HTTP errors and redacts authorization data", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          "Authorization: Bearer super-secret-token access_token=another-secret",
          { status: 503 },
        ),
      );
    const client = new RemoteMusicClient({ fetch: request });

    const error = await client
      .getNowPlaying()
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/HTTP 503/u);
    expect((error as Error).message).not.toMatch(
      /super-secret-token|another-secret/u,
    );
  });

  it("fails malformed responses explicitly", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ station: { id: "missing-fields" } }));
    const client = new RemoteMusicClient({ fetch: request });

    await expect(client.getNowPlaying()).rejects.toThrow(/failed validation/u);
  });

  it("times out stalled HTTP requests", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    const client = new RemoteMusicClient({ fetch: request, timeoutMs: 10 });

    await expect(client.getNowPlaying()).rejects.toThrow(
      /timed out after 10 ms/u,
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function nowPlayingPayload(): Record<string, unknown> {
  return {
    station: { id: "eulr-focus", name: "eulr focus radio" },
    track: remoteTrackPayload(),
    positionSeconds: 70.623,
    startedAt: "2026-07-15T11:58:49.377Z",
    endsAt: "2026-07-15T12:01:17.013Z",
    nextTrack: { ...remoteTrackPayload(), id: "next", title: "Next" },
    serverTime: "2026-07-15T12:00:00.000Z",
  };
}

function remoteTrackPayload(): Record<string, unknown> {
  return {
    id: "bubbles",
    title: "Bubbles",
    artist: "HoliznaCC0",
    durationSeconds: 147.636,
    audioUrl: "https://cdn.example.test/bubbles.mp3",
    license: {
      name: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
  };
}
