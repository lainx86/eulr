import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReadTool } from "../../src/tools/read.js";
import { removeWorkspace, temporaryWorkspace, toolContext } from "./helpers.js";

describe("ReadTool", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  async function workspace(): Promise<string> {
    const result = await temporaryWorkspace();
    workspaces.push(result);
    return result;
  }

  it("reads a text file with line numbers", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "example.ts"), "first\nsecond\n");

    const result = await new ReadTool().execute(
      { path: "example.ts" },
      toolContext(cwd),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("example.ts\n1 | first\n2 | second");
    expect(result.metadata?.preview).toBe("first\nsecond");
    expect(result.metadata?.previewTruncated).toBe(false);
  });

  it("reads an inclusive line range", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "lines.txt"), "one\ntwo\nthree\nfour");

    const result = await new ReadTool().execute(
      { path: "lines.txt", startLine: 2, endLine: 3 },
      toolContext(cwd),
    );

    expect(result.content).toBe("lines.txt\n2 | two\n3 | three");
  });

  it("rejects binary data", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "binary.bin"), Buffer.from([1, 0, 2, 3]));

    await expect(
      new ReadTool().execute({ path: "binary.bin" }, toolContext(cwd)),
    ).rejects.toThrow(/binary file/u);
  });

  it("retains the beginning and end when output is truncated", async () => {
    const cwd = await workspace();
    await writeFile(
      path.join(cwd, "large.txt"),
      `${"head".repeat(40)}\n${"tail".repeat(40)}`,
    );

    const result = await new ReadTool({ maxOutputChars: 80 }).execute(
      { path: "large.txt" },
      toolContext(cwd),
    );

    expect(result.content).toContain("truncated");
    expect(result.content).toContain("large.txt");
    expect(result.content).toContain("tail");
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.preview).toContain("truncated");
    expect(result.metadata?.preview).not.toContain("1 |");
    expect(result.metadata?.previewTruncated).toBe(true);
  });
});
