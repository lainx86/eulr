import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EditTool } from "../../src/tools/edit.js";
import { removeWorkspace, temporaryWorkspace, toolContext } from "./helpers.js";

describe("EditTool", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  async function fixture(content: string): Promise<[string, string]> {
    const cwd = await temporaryWorkspace();
    workspaces.push(cwd);
    const filePath = path.join(cwd, "fixture.txt");
    await writeFile(filePath, content);
    return [cwd, filePath];
  }

  it("performs one exact replacement", async () => {
    const [cwd, filePath] = await fixture("before needle after\n");

    const result = await new EditTool().execute(
      {
        path: "fixture.txt",
        oldText: "needle",
        newText: "replacement",
        replaceAll: false,
      },
      toolContext(cwd),
    );

    expect(await readFile(filePath, "utf8")).toBe("before replacement after\n");
    expect(result.metadata?.replacements).toBe(1);
    expect(result.metadata?.fileChange).toEqual({
      path: "fixture.txt",
      before: "before needle after\n",
      after: "before replacement after\n",
      truncated: false,
    });
  });

  it("fails without changing the file when text is absent", async () => {
    const [cwd, filePath] = await fixture("original\n");

    await expect(
      new EditTool().execute(
        {
          path: "fixture.txt",
          oldText: "missing",
          newText: "changed",
          replaceAll: false,
        },
        toolContext(cwd),
      ),
    ).rejects.toThrow(/not found/u);
    expect(await readFile(filePath, "utf8")).toBe("original\n");
  });

  it("fails without changing the file when a match is ambiguous", async () => {
    const [cwd, filePath] = await fixture("same same\n");

    await expect(
      new EditTool().execute(
        {
          path: "fixture.txt",
          oldText: "same",
          newText: "new",
          replaceAll: false,
        },
        toolContext(cwd),
      ),
    ).rejects.toThrow(/occurs 2 times/u);
    expect(await readFile(filePath, "utf8")).toBe("same same\n");
  });

  it("replaces every exact match when replaceAll is enabled", async () => {
    const [cwd, filePath] = await fixture("same same same\n");

    const result = await new EditTool().execute(
      {
        path: "fixture.txt",
        oldText: "same",
        newText: "new",
        replaceAll: true,
      },
      toolContext(cwd),
    );

    expect(await readFile(filePath, "utf8")).toBe("new new new\n");
    expect(result.metadata?.replacements).toBe(3);
  });

  it("bounds file change snapshots", async () => {
    const [cwd] = await fixture(`before-${"a".repeat(30_000)}\n`);

    const result = await new EditTool().execute(
      {
        path: "fixture.txt",
        oldText: "before-",
        newText: "after-",
        replaceAll: false,
      },
      toolContext(cwd),
    );
    const fileChange = result.metadata?.fileChange as
      { before: string; after: string; truncated: boolean } | undefined;

    expect(fileChange?.truncated).toBe(true);
    expect(fileChange?.before).toContain("truncated");
    expect(fileChange?.after).toContain("truncated");
    expect(fileChange?.before.length).toBeLessThan(30_008);
    expect(fileChange?.after.length).toBeLessThan(30_007);
  });
});
