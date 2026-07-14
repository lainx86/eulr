import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const DEFAULT_MAX_BYTES = 32 * 1024;

export interface ProjectInstructionResult {
  path: string;
  content?: string;
  changed: boolean;
  reloaded: boolean;
  truncated: boolean;
}

export class ProjectInstructionLoader {
  private signature?: string;
  private content?: string;
  private hasLoaded = false;
  private readonly path: string;

  constructor(
    private readonly cwd: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    this.path = join(cwd, "AGENTS.md");
  }

  async load(): Promise<ProjectInstructionResult> {
    let details;
    try {
      details = await stat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const changed = this.hasLoaded && this.content !== undefined;
        this.signature = undefined;
        this.content = undefined;
        this.hasLoaded = true;
        return {
          path: this.path,
          changed,
          reloaded: changed,
          truncated: false,
        };
      }
      throw error;
    }

    if (!details.isFile()) {
      throw new Error(`${this.path} is not a regular file`);
    }
    const canonicalRoot = await realpath(this.cwd);
    const canonicalPath = await realpath(this.path);
    const fromRoot = relative(canonicalRoot, canonicalPath);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error("AGENTS.md resolves outside the working directory");
    }

    const signature = `${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}`;
    if (signature === this.signature) {
      return {
        path: this.path,
        content: this.content,
        changed: false,
        reloaded: false,
        truncated: details.size > this.maxBytes,
      };
    }

    const handle = await open(this.path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(details.size, this.maxBytes + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const truncated =
        details.size > this.maxBytes || bytesRead > this.maxBytes;
      const text = buffer
        .subarray(0, Math.min(bytesRead, this.maxBytes))
        .toString("utf8");
      this.content = truncated
        ? `${text}\n\n[AGENTS.md truncated at ${this.maxBytes} bytes]`
        : text;
      const reloaded = this.hasLoaded;
      this.signature = signature;
      this.hasLoaded = true;
      return {
        path: this.path,
        content: this.content,
        changed: true,
        reloaded,
        truncated,
      };
    } finally {
      await handle.close();
    }
  }
}
