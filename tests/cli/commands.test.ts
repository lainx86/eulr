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

  it("does not turn ordinary user input into a slash command", () => {
    expect(parseInteractiveCommand("fix the tests")).toBeUndefined();
  });
});
