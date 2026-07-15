import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("npm package contents", () => {
  it("does not publish bundled music files or the former tracks directory", async () => {
    const cache = await mkdtemp(path.join(tmpdir(), "eulr-npm-cache-"));
    let paths: string[];
    try {
      await run(
        "npm",
        ["pack", "--pack-destination", cache, "--ignore-scripts"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, npm_config_cache: cache },
        },
      );
      const archiveName = (await readdir(cache)).find((name) =>
        name.endsWith(".tgz"),
      );
      expect(archiveName).toBeDefined();
      const { stdout } = await run(
        "tar",
        ["-tzf", path.join(cache, archiveName ?? "missing.tgz")],
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      paths = stdout.split("\n").filter(Boolean);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }

    expect(paths).not.toContainEqual(
      expect.stringMatching(/^package\/assets\/music\/tracks(?:\/|$)/u),
    );
    expect(paths).not.toContainEqual(expect.stringMatching(/\.(?:mp3|wav)$/iu));
    expect(paths).not.toContainEqual(
      expect.stringMatching(/\/music\/builtin-library\./u),
    );
  });
});
