import { z } from "zod";

import { AuthenticationError, CancellationError } from "../utils/errors.js";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_ENDPOINTS,
  credentialFromTokenResponse,
  exchangeAuthorizationCode,
} from "./chatgpt-oauth.js";
import type { ChatGPTCredential, FetchImplementation } from "./types.js";

export const DEVICE_AUTH_START_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const DEVICE_AUTH_POLL_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/token";
export const DEVICE_AUTH_VERIFICATION_URL =
  "https://auth.openai.com/codex/device";
export const DEVICE_AUTH_REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback";
export const DEFAULT_DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

const intervalSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return value;
}, z.number().int().positive());

const deviceCodeSchema = z
  .object({
    device_auth_id: z.string().min(1),
    user_code: z.string().min(1).optional(),
    usercode: z.string().min(1).optional(),
    interval: intervalSchema,
  })
  .refine(
    (value) => value.user_code !== undefined || value.usercode !== undefined,
    {
      message: "Device authorization response omitted user_code",
    },
  );

const deviceTokenSchema = z.object({
  authorization_code: z.string().min(1),
  code_challenge: z.string().min(1),
  code_verifier: z.string().min(1),
});

export interface DeviceAuthEndpoints {
  start: string;
  poll: string;
  verification: string;
  token: string;
}

export const DEFAULT_DEVICE_AUTH_ENDPOINTS: DeviceAuthEndpoints = {
  start: DEVICE_AUTH_START_ENDPOINT,
  poll: DEVICE_AUTH_POLL_ENDPOINT,
  verification: DEVICE_AUTH_VERIFICATION_URL,
  token: DEFAULT_OAUTH_ENDPOINTS.token,
};

export interface DeviceCodePrompt {
  verificationUrl: string;
  userCode: string;
}

export interface DeviceLoginOptions {
  fetch?: FetchImplementation;
  clientId?: string;
  endpoints?: Partial<DeviceAuthEndpoints>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onUserCode?: (prompt: DeviceCodePrompt) => void | Promise<void>;
}

export async function loginWithDeviceCode(
  options: DeviceLoginOptions = {},
): Promise<ChatGPTCredential> {
  const request = options.fetch ?? fetch;
  const clientId = options.clientId ?? CHATGPT_OAUTH_CLIENT_ID;
  const now = options.now ?? Date.now;
  const deadline =
    now() + (options.timeoutMs ?? DEFAULT_DEVICE_AUTH_TIMEOUT_MS);
  assertNotAborted(options.signal);

  let startResponse: Response;
  try {
    startResponse = await request(
      options.endpoints?.start ?? DEFAULT_DEVICE_AUTH_ENDPOINTS.start,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
        signal: options.signal,
      },
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw new CancellationError("ChatGPT device login cancelled", {
        cause: error,
      });
    }
    throw new AuthenticationError("Unable to start ChatGPT device login", {
      cause: error,
    });
  }

  if (startResponse.status === 404) {
    await startResponse.body?.cancel().catch(() => undefined);
    throw new AuthenticationError(
      "ChatGPT device authorization is not enabled for this account or workspace",
    );
  }
  if (!startResponse.ok) {
    await startResponse.body?.cancel().catch(() => undefined);
    throw new AuthenticationError(
      `Unable to start ChatGPT device login (HTTP ${startResponse.status})`,
    );
  }

  let device;
  try {
    device = deviceCodeSchema.parse(await startResponse.json());
  } catch (error) {
    throw new AuthenticationError("ChatGPT device-code response was invalid", {
      cause: error,
    });
  }
  const userCode = device.user_code ?? device.usercode;
  if (userCode === undefined) {
    throw new AuthenticationError(
      "ChatGPT device-code response omitted user_code",
    );
  }
  await options.onUserCode?.({
    verificationUrl:
      options.endpoints?.verification ??
      DEFAULT_DEVICE_AUTH_ENDPOINTS.verification,
    userCode,
  });

  const sleep = options.sleep ?? abortableSleep;
  while (now() < deadline) {
    assertNotAborted(options.signal);
    let pollResponse: Response;
    try {
      pollResponse = await request(
        options.endpoints?.poll ?? DEFAULT_DEVICE_AUTH_ENDPOINTS.poll,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_auth_id: device.device_auth_id,
            user_code: userCode,
          }),
          signal: options.signal,
        },
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw new CancellationError("ChatGPT device login cancelled", {
          cause: error,
        });
      }
      throw new AuthenticationError(
        "ChatGPT device authorization polling failed",
        {
          cause: error,
        },
      );
    }

    if (pollResponse.status === 403 || pollResponse.status === 404) {
      await pollResponse.body?.cancel().catch(() => undefined);
      const remaining = deadline - now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(device.interval * 1000, remaining), options.signal);
      continue;
    }
    if (!pollResponse.ok) {
      await pollResponse.body?.cancel().catch(() => undefined);
      throw new AuthenticationError(
        `ChatGPT device authorization failed (HTTP ${pollResponse.status})`,
      );
    }

    let authorization;
    try {
      authorization = deviceTokenSchema.parse(await pollResponse.json());
    } catch (error) {
      throw new AuthenticationError(
        "ChatGPT device authorization response was invalid",
        { cause: error },
      );
    }
    const tokens = await exchangeAuthorizationCode({
      code: authorization.authorization_code,
      verifier: authorization.code_verifier,
      redirectUri: DEVICE_AUTH_REDIRECT_URI,
      clientId,
      tokenEndpoint:
        options.endpoints?.token ?? DEFAULT_DEVICE_AUTH_ENDPOINTS.token,
      fetch: request,
      signal: options.signal,
    });
    return credentialFromTokenResponse(tokens, now());
  }

  throw new AuthenticationError("ChatGPT device login timed out");
}

export function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancellationError("ChatGPT device login cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancellationError("ChatGPT device login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CancellationError("ChatGPT device login cancelled");
  }
}
