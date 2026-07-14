import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { SessionError } from "../utils/errors.js";
import { sessionEventSchema } from "./events.js";
import type { SessionEvent } from "./events.js";
import { reconstructSession } from "./state.js";
import type { SessionState } from "./state.js";

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{3,63}$/i;
const TAIL_READ_CHUNK_BYTES = 16 * 1024;

export interface SessionStoreOptions {
  directory?: string;
}

export class SessionStore {
  readonly directory: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options: SessionStoreOptions = {}) {
    this.directory = options.directory ?? join(homedir(), ".eulr", "sessions");
  }

  createId(): string {
    return randomBytes(6).toString("base64url").toLowerCase();
  }

  async append(sessionId: string, event: SessionEvent): Promise<void> {
    this.validateSessionId(sessionId);
    const validated = sessionEventSchema.parse(event);
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await this.ensureDirectory();
        const path = this.pathFor(sessionId);
        await this.repairPartialTail(path);
        const handle = await open(path, "a", 0o600);
        try {
          await handle.write(`${JSON.stringify(validated)}\n`);
          await handle.datasync();
        } finally {
          await handle.close();
        }
        if (process.platform !== "win32") {
          await chmod(path, 0o600);
        }
      })
      .catch((error: unknown) => {
        throw new SessionError(`Unable to append session ${sessionId}`, {
          cause: error,
        });
      });

    this.writes.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.writes.get(sessionId) === current) {
        this.writes.delete(sessionId);
      }
    }
  }

  async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    this.validateSessionId(sessionId);
    await this.waitFor(sessionId);
    const path = this.pathFor(sessionId);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw new SessionError(`Unable to load session ${sessionId}`, {
        cause: error,
      });
    }

    const endsWithNewline = bytes.length === 0 || bytes.at(-1) === 0x0a;
    const lines = bytes.toString("utf8").split("\n");
    if (endsWithNewline) {
      lines.pop();
    }

    const events: SessionEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") {
        continue;
      }
      const isPartialFinalLine = !endsWithNewline && index === lines.length - 1;
      try {
        events.push(sessionEventSchema.parse(JSON.parse(line)));
      } catch (error) {
        if (isPartialFinalLine) {
          break;
        }
        throw new SessionError(
          `Invalid event in session ${sessionId} at line ${index + 1}`,
          { cause: error },
        );
      }
    }
    return events;
  }

  async load(sessionId: string): Promise<SessionState> {
    const events = await this.loadEvents(sessionId);
    try {
      return reconstructSession(events);
    } catch (error) {
      throw new SessionError(`Unable to reconstruct session ${sessionId}`, {
        cause: error,
      });
    }
  }

  async exists(sessionId: string): Promise<boolean> {
    this.validateSessionId(sessionId);
    try {
      await access(this.pathFor(sessionId), fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async list(limit = 20): Promise<SessionState[]> {
    await this.ensureDirectory();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const states = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const id = entry.name.slice(0, -".jsonl".length);
          try {
            return await this.load(id);
          } catch {
            return undefined;
          }
        }),
    );
    return states
      .filter((state): state is SessionState => state !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(0, limit));
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()]);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(this.directory, 0o700);
    }
  }

  private async repairPartialTail(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      const finalByte = Buffer.allocUnsafe(1);
      await handle.read(finalByte, 0, 1, size - 1);
      if (finalByte[0] === 0x0a) return;

      const { tail, newlineOffset } = await readFinalLine(handle, size);
      const valid = (() => {
        try {
          sessionEventSchema.parse(JSON.parse(tail));
          return true;
        } catch {
          return false;
        }
      })();

      if (valid) {
        await handle.write(Buffer.from("\n"), 0, 1, size);
      } else {
        await handle.truncate(newlineOffset + 1);
      }
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }

  private validateSessionId(sessionId: string): void {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new SessionError(`Invalid session ID: ${sessionId}`);
    }
  }

  private async waitFor(sessionId: string): Promise<void> {
    await this.writes.get(sessionId);
  }
}

async function readFinalLine(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<{ tail: string; newlineOffset: number }> {
  const chunks: Buffer[] = [];
  let cursor = size;
  while (cursor > 0) {
    const start = Math.max(0, cursor - TAIL_READ_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(cursor - start);
    await handle.read(chunk, 0, chunk.length, start);
    const relativeNewline = chunk.lastIndexOf(0x0a);
    if (relativeNewline >= 0) {
      chunks.unshift(chunk.subarray(relativeNewline + 1));
      return {
        tail: Buffer.concat(chunks).toString("utf8"),
        newlineOffset: start + relativeNewline,
      };
    }
    chunks.unshift(chunk);
    cursor = start;
  }
  return { tail: Buffer.concat(chunks).toString("utf8"), newlineOffset: -1 };
}
