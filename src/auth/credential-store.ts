import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { AuthenticationError, CancellationError } from "../utils/errors.js";
import type {
  ApiCredential,
  ChatGPTCredential,
  StoredCredential,
} from "./types.js";

const chatGPTCredentialSchema = z.object({
  type: z.literal("chatgpt"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  expiresAt: z.number().finite().nonnegative(),
  accountId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  planType: z.string().min(1).optional(),
  isFedRamp: z.boolean().optional(),
  lastRefreshAt: z.number().finite().nonnegative().optional(),
});

const apiCredentialSchema = z.object({
  type: z.literal("api-key"),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

const storedCredentialSchema = z.discriminatedUnion("type", [
  chatGPTCredentialSchema,
  apiCredentialSchema,
]);

const authFileSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), storedCredentialSchema),
});

interface AuthFile {
  version: 1;
  providers: Record<string, StoredCredential>;
}

interface LockRecord {
  pid: number;
  createdAt: number;
  token: string;
}

const LOCK_RETRY_MS = 25;
const MALFORMED_LOCK_STALE_MS = 2 * 60 * 1000;

export interface CredentialStoreOptions {
  path?: string;
}

export class CredentialStore {
  readonly path: string;
  readonly directory: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(options: CredentialStoreOptions = {}) {
    this.path = options.path ?? path.join(homedir(), ".eulr", "auth.json");
    this.directory = path.dirname(this.path);
  }

  async get(providerId: string): Promise<StoredCredential | undefined> {
    await this.mutation;
    return (await this.loadUnlocked()).providers[providerId];
  }

  async getChatGPT(
    providerId = "openai-codex",
  ): Promise<ChatGPTCredential | undefined> {
    const credential = await this.get(providerId);
    if (credential === undefined) {
      return undefined;
    }
    if (credential.type !== "chatgpt") {
      throw new AuthenticationError(
        `Credential for ${providerId} is not a ChatGPT credential`,
      );
    }
    const { type: _type, ...value } = credential;
    return value;
  }

  async getApiKey(
    providerId = "openai-compatible",
  ): Promise<ApiCredential | undefined> {
    const credential = await this.get(providerId);
    if (credential === undefined) {
      return undefined;
    }
    if (credential.type !== "api-key") {
      throw new AuthenticationError(
        `Credential for ${providerId} is not an API-key credential`,
      );
    }
    const { type: _type, ...value } = credential;
    return value;
  }

  async save(providerId: string, credential: StoredCredential): Promise<void> {
    await this.mutate((file) => {
      file.providers[providerId] = storedCredentialSchema.parse(credential);
    });
  }

  async saveChatGPT(
    credential: ChatGPTCredential,
    providerId = "openai-codex",
  ): Promise<void> {
    await this.save(providerId, { type: "chatgpt", ...credential });
  }

  async saveApiKey(
    credential: ApiCredential,
    providerId = "openai-compatible",
  ): Promise<void> {
    await this.save(providerId, { type: "api-key", ...credential });
  }

  async delete(providerId: string): Promise<boolean> {
    let removed = false;
    await this.mutate((file) => {
      removed = Object.hasOwn(file.providers, providerId);
      delete file.providers[providerId];
    });
    return removed;
  }

  async listProviderIds(): Promise<string[]> {
    await this.mutation;
    return Object.keys((await this.loadUnlocked()).providers).sort();
  }

  async withRefreshLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.ensureDirectory();
    return withFileLock(`${this.path}.refresh.lock`, operation, signal);
  }

  private async mutate(change: (file: AuthFile) => void): Promise<void> {
    const operation = this.mutation
      .catch(() => undefined)
      .then(async () => {
        await this.ensureDirectory();
        await withFileLock(`${this.path}.lock`, async () => {
          const file = await this.loadUnlocked();
          change(file);
          await atomicWriteFile(
            this.path,
            `${JSON.stringify(file, null, 2)}\n`,
            {
              mode: 0o600,
            },
          );
          if (process.platform !== "win32") {
            await chmod(this.path, 0o600);
          }
        });
      });
    this.mutation = operation;
    await operation;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(this.directory, 0o700);
    }
  }

  private async loadUnlocked(): Promise<AuthFile> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, providers: {} };
      }
      throw new AuthenticationError("Unable to read eulr credentials", {
        cause: error,
      });
    }

    try {
      return authFileSchema.parse(JSON.parse(content));
    } catch (error) {
      throw new AuthenticationError(
        `Credential file is invalid: ${this.path}. Move it aside and log in again.`,
        { cause: error },
      );
    }
  }
}

async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const record: LockRecord = {
    pid: process.pid,
    createdAt: Date.now(),
    token: randomUUID(),
  };
  const serialized = `${JSON.stringify(record)}\n`;

  for (;;) {
    if (signal?.aborted) {
      throw new CancellationError("Credential operation cancelled", {
        cause: signal.reason,
      });
    }
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new AuthenticationError("Unable to lock eulr credentials", {
          cause: error,
        });
      }
      if (await isAbandonedLock(lockPath)) {
        await unlink(lockPath).catch((unlinkError: unknown) => {
          const code = (unlinkError as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw unlinkError;
        });
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    const contents = await readFile(lockPath, "utf8").catch(() => undefined);
    if (contents === serialized) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

async function isAbandonedLock(lockPath: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(lockPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  try {
    const value = JSON.parse(contents) as Partial<LockRecord>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0) {
      throw new Error("invalid lock owner");
    }
    try {
      process.kill(value.pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    try {
      return (
        Date.now() - (await stat(lockPath)).mtimeMs >= MALFORMED_LOCK_STALE_MS
      );
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
}

export { authFileSchema, storedCredentialSchema };
