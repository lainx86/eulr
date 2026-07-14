import { afterEach, describe, expect, it, vi } from "vitest";

import { CancellationError } from "../../src/utils/errors.js";
import { BashTool } from "../../src/tools/bash.js";
import {
  nodeCommand,
  removeWorkspace,
  temporaryWorkspace,
  toolContext,
} from "./helpers.js";

function stagedAbortSignal(abortOnRead: number): AbortSignal {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= abortOnRead;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as AbortSignal;
}

describe("BashTool", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  async function workspace(): Promise<string> {
    const result = await temporaryWorkspace();
    workspaces.push(result);
    return result;
  }

  it("returns a zero exit code for a successful command", async () => {
    const cwd = await workspace();
    const result = await new BashTool().execute(
      { command: nodeCommand("process.exit(0)") },
      toolContext(cwd),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Exit code: 0");
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("returns nonzero exit status as a tool error", async () => {
    const cwd = await workspace();
    const result = await new BashTool().execute(
      { command: nodeCommand("process.exit(7)") },
      toolContext(cwd),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exit code: 7");
  });

  it("captures and streams stdout and stderr", async () => {
    const cwd = await workspace();
    const onOutput = vi.fn();
    const result = await new BashTool().execute(
      {
        command: nodeCommand(
          "const fs = require('node:fs'); fs.writeSync(1, 'hello-out'); fs.writeSync(2, 'hello-err')",
        ),
      },
      toolContext(cwd, { onOutput }),
    );

    expect(result.content).toContain("stdout:\nhello-out");
    expect(result.content).toContain("stderr:\nhello-err");
    expect(onOutput).toHaveBeenCalledWith("stdout", "hello-out");
    expect(onOutput).toHaveBeenCalledWith("stderr", "hello-err");
    expect(result.metadata?.stdout).toBe("hello-out");
    expect(result.metadata?.stderr).toBe("hello-err");
  });

  it("terminates a command after its timeout", async () => {
    const cwd = await workspace();
    const result = await new BashTool({ forceKillDelayMs: 10 }).execute(
      {
        command: nodeCommand("setTimeout(() => {}, 10_000)"),
        timeoutMs: 40,
      },
      toolContext(cwd),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Timed out after 40 ms");
    expect(result.metadata?.timedOut).toBe(true);
  });

  it("cancels the child process through AbortSignal", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const execution = new BashTool({ forceKillDelayMs: 10 }).execute(
      { command: nodeCommand("setTimeout(() => {}, 10_000)") },
      toolContext(cwd, { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 40);

    await expect(execution).rejects.toBeInstanceOf(CancellationError);
  });

  it("rechecks cancellation after resolving the workspace", async () => {
    const cwd = await workspace();
    const signal = stagedAbortSignal(2);

    await expect(
      new BashTool().execute(
        { command: nodeCommand("process.exit(0)") },
        toolContext(cwd, { signal }),
      ),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it("closes the abort race before listener registration", async () => {
    const cwd = await workspace();
    const signal = stagedAbortSignal(3);

    await expect(
      new BashTool({ forceKillDelayMs: 10 }).execute(
        { command: nodeCommand("setTimeout(() => {}, 10_000)") },
        toolContext(cwd, { signal }),
      ),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it("retains head and tail output when command output is truncated", async () => {
    const cwd = await workspace();
    const result = await new BashTool({ maxOutputChars: 200 }).execute(
      {
        command: nodeCommand(
          "require('node:fs').writeSync(1, 'HEAD-' + 'x'.repeat(1000) + '-TAIL')",
        ),
      },
      toolContext(cwd),
    );

    expect(result.content).toContain("HEAD-");
    expect(result.content).toContain("-TAIL");
    expect(result.content).toContain("truncated");
    expect(result.metadata?.stdoutTruncated).toBe(true);
    expect(result.metadata?.stdout).toContain("HEAD-");
    expect(result.metadata?.stdout).toContain("-TAIL");
    expect(result.metadata?.stdout).toContain("truncated");
  });
});
