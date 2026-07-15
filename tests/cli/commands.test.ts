import { describe, expect, it } from "vitest";

import {
  INTERACTIVE_HELP,
  parseInteractiveCommand,
} from "../../src/cli/commands.js";

describe("interactive command parsing", () => {
  it("treats /resume without an ID as a valid selector request", () => {
    expect(parseInteractiveCommand("/resume")).toEqual({ name: "resume" });
    expect(parseInteractiveCommand("/resume session-42")).toEqual({
      name: "resume",
      sessionId: "session-42",
    });
    expect(INTERACTIVE_HELP).toContain("/resume [session-id]");
  });

  it.each([
    ["/music play", { type: "play" }],
    ["/music remote", { type: "remote" }],
    ["/music local", { type: "local" }],
    ["/music off", { type: "off" }],
    ["/music pause", { type: "pause" }],
    ["/music toggle", { type: "toggle" }],
    ["/music next", { type: "next" }],
    ["/music previous", { type: "previous" }],
    ["/music shuffle", { type: "shuffle" }],
    ["/music repeat", { type: "repeat" }],
    ["/music status", { type: "status" }],
  ])("parses %s", (input, command) => {
    expect(parseInteractiveCommand(input)).toEqual({ name: "music", command });
  });

  it("preserves spaces in a music library path", () => {
    expect(parseInteractiveCommand("/music library /home/me/My Music")).toEqual(
      {
        name: "music",
        command: { type: "library", path: "/home/me/My Music" },
      },
    );
  });

  it("parses numeric seek and volume commands", () => {
    expect(parseInteractiveCommand("/music seek 12.5")).toEqual({
      name: "music",
      command: { type: "seek", seconds: 12.5 },
    });
    expect(parseInteractiveCommand("/music volume 85")).toEqual({
      name: "music",
      command: { type: "volume", volume: 85 },
    });
  });

  it.each([
    "/music",
    "/music library",
    "/music seek -1",
    "/music seek later",
    "/music volume -1",
    "/music volume 101",
    "/music play now",
    "/music builtin",
    "/music unknown",
  ])("returns an actionable parse error for %s", (input) => {
    const parsed = parseInteractiveCommand(input);
    expect(parsed).toMatchObject({ name: "unknown", input });
    expect(parsed).toHaveProperty("reason");
  });

  it("does not turn ordinary user input into a slash command", () => {
    expect(parseInteractiveCommand("fix the tests")).toBeUndefined();
  });
});
