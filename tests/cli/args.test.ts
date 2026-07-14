import { describe, expect, it } from "vitest";

import { HELP_TEXT, parseArgs } from "../../src/cli/args.js";

describe("CLI arguments", () => {
  it("parses a one-shot task with global options", () => {
    expect(
      parseArgs([
        "--cwd",
        "/repo",
        "--provider",
        "openai-compatible",
        "--model",
        "model-a",
        "--yes",
        "fix the tests",
      ]),
    ).toMatchObject({
      command: "run",
      task: "fix the tests",
      cwd: "/repo",
      provider: "openai-compatible",
      model: "model-a",
      yes: true,
    });
  });

  it("parses auth and listing commands", () => {
    expect(parseArgs(["auth", "login", "--device"])).toMatchObject({
      command: "auth-login",
      device: true,
    });
    expect(parseArgs(["auth", "logout"])).toMatchObject({
      command: "auth-logout",
    });
    expect(parseArgs(["models"])).toMatchObject({ command: "models" });
    expect(parseArgs(["sessions"])).toMatchObject({ command: "sessions" });
  });

  it("rejects invalid combinations", () => {
    expect(() => parseArgs(["--device", "task"])).toThrow(/only valid/i);
    expect(() => parseArgs(["--resume", "abc", "task"])).toThrow(
      /cannot be combined/i,
    );
    expect(() => parseArgs(["--unknown"])).toThrow(/unknown option/i);
    expect(() => parseArgs(["--plain", "--tui"])).toThrow(
      /cannot be combined/i,
    );
  });

  it("parses explicit renderer selection", () => {
    expect(parseArgs(["--plain", "fix tests"])).toMatchObject({
      plain: true,
      tui: false,
      task: "fix tests",
    });
    expect(parseArgs(["--tui"])).toMatchObject({
      plain: false,
      tui: true,
    });
    expect(HELP_TEXT).toContain("--plain");
    expect(HELP_TEXT).toContain("--tui");
  });
});
