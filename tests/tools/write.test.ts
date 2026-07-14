import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WriteTool } from "../../src/tools/write.js";
import { removeWorkspace, temporaryWorkspace, toolContext } from "./helpers.js";

describe("WriteTool", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  async function workspace(): Promise<string> {
    const result = await temporaryWorkspace();
    workspaces.push(result);
    return result;
  }

  it("creates a new file with a final newline", async () => {
    const cwd = await workspace();

    const result = await new WriteTool().execute(
      { path: "new.txt", content: "hello" },
      toolContext(cwd),
    );

    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("hello\n");
    expect(result.content).toMatch(/^Created new\.txt/u);
    expect(result.metadata?.fileChange).toEqual({
      path: "new.txt",
      before: null,
      after: "hello\n",
      truncated: false,
    });
  });

  it("creates parent directories", async () => {
    const cwd = await workspace();

    await new WriteTool().execute(
      { path: "nested/deep/file.txt", content: "value\n" },
      toolContext(cwd),
    );

    expect(await readFile(path.join(cwd, "nested/deep/file.txt"), "utf8")).toBe(
      "value\n",
    );
  });

  it("overwrites a file atomically and preserves its mode", async () => {
    const cwd = await workspace();
    const filePath = path.join(cwd, "script.sh");
    await writeFile(filePath, "old\n");
    await chmod(filePath, 0o744);

    const result = await new WriteTool().execute(
      { path: "script.sh", content: "new\n" },
      toolContext(cwd),
    );

    expect(await readFile(filePath, "utf8")).toBe("new\n");
    expect((await stat(filePath)).mode & 0o777).toBe(0o744);
    expect(await readdir(cwd)).toEqual(["script.sh"]);
    expect(result.content).toMatch(/^Replaced script\.sh/u);
    expect(result.metadata?.fileChange).toEqual({
      path: "script.sh",
      before: "old\n",
      after: "new\n",
      truncated: false,
    });
  });

  it("reports identical content without rewriting", async () => {
    const cwd = await workspace();
    await mkdir(path.join(cwd, "folder"));
    const filePath = path.join(cwd, "folder/same.txt");
    await writeFile(filePath, "same\n");
    const before = await stat(filePath);

    const result = await new WriteTool().execute(
      { path: "folder/same.txt", content: "same\n" },
      toolContext(cwd),
    );

    const after = await stat(filePath);
    expect(result.content).toMatch(/^Unchanged/u);
    expect(result.metadata?.changed).toBe(false);
    expect(result.metadata?.fileChange).toBeUndefined();
    expect(after.ino).toBe(before.ino);
  });

  it("bounds file change snapshots", async () => {
    const cwd = await workspace();
    const filePath = path.join(cwd, "large.txt");
    await writeFile(filePath, "a".repeat(30_000));

    const result = await new WriteTool().execute(
      { path: "large.txt", content: "b".repeat(30_000) },
      toolContext(cwd),
    );
    const fileChange = result.metadata?.fileChange as
      { before: string; after: string; truncated: boolean } | undefined;

    expect(fileChange?.truncated).toBe(true);
    expect(fileChange?.before).toContain("truncated");
    expect(fileChange?.after).toContain("truncated");
    expect(fileChange?.before.length).toBeLessThan(30_000);
    expect(fileChange?.after.length).toBeLessThan(30_001);
  });
});
