import { describe, expect, it, vi } from "vitest";

import {
  DEVICE_AUTH_REDIRECT_URI,
  loginWithDeviceCode,
} from "../../src/auth/device-auth.js";
import { CancellationError } from "../../src/utils/errors.js";
import { fakeFetch, jsonResponse, makeJwt } from "./helpers.js";

describe("ChatGPT device authorization", () => {
  it("polls pending statuses at the server interval and exchanges the code", async () => {
    let pollCount = 0;
    const sleeps: number[] = [];
    const request = vi.fn(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/usercode")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            client_id: "client",
          });
          return jsonResponse({
            device_auth_id: "device-1",
            usercode: "ABCD-EFGH",
            interval: "2",
          });
        }
        if (url.endsWith("/token") && url.includes("deviceauth")) {
          pollCount += 1;
          expect(JSON.parse(String(init?.body))).toEqual({
            device_auth_id: "device-1",
            user_code: "ABCD-EFGH",
          });
          return pollCount === 1
            ? new Response(null, { status: 403 })
            : jsonResponse({
                authorization_code: "authorization-code",
                code_challenge: "challenge",
                code_verifier: "verifier",
              });
        }
        expect(url).toBe("https://auth.test/oauth/token");
        const form = init?.body as URLSearchParams;
        expect(form.get("redirect_uri")).toBe(DEVICE_AUTH_REDIRECT_URI);
        expect(form.get("code_verifier")).toBe("verifier");
        return jsonResponse({
          access_token: makeJwt({ exp: 1000 }),
          refresh_token: "refresh-secret",
          id_token: makeJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
          }),
        });
      },
    );
    const prompt = vi.fn();

    const credential = await loginWithDeviceCode({
      fetch: fakeFetch(request),
      clientId: "client",
      endpoints: { token: "https://auth.test/oauth/token" },
      now: () => 100,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      onUserCode: prompt,
    });

    expect(prompt).toHaveBeenCalledWith({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    expect(sleeps).toEqual([2_000]);
    expect(pollCount).toBe(2);
    expect(credential.accountId).toBe("account-1");
  });

  it("reports disabled device authorization", async () => {
    await expect(
      loginWithDeviceCode({
        fetch: fakeFetch(async () => new Response(null, { status: 404 })),
      }),
    ).rejects.toThrow("not enabled");
  });

  it("cancels polling through AbortSignal", async () => {
    const controller = new AbortController();
    await expect(
      loginWithDeviceCode({
        signal: controller.signal,
        fetch: fakeFetch(async () =>
          jsonResponse({
            device_auth_id: "device-1",
            user_code: "CODE",
            interval: "1",
          }),
        ),
        onUserCode: () => controller.abort(),
      }),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it("times out while authorization remains pending", async () => {
    let now = 0;
    await expect(
      loginWithDeviceCode({
        timeoutMs: 2_000,
        now: () => now,
        fetch: fakeFetch(async (input) =>
          String(input).endsWith("/usercode")
            ? jsonResponse({
                device_auth_id: "device-1",
                user_code: "CODE",
                interval: "1",
              })
            : new Response(null, { status: 404 }),
        ),
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow("timed out");
  });
});
