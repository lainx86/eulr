import { describe, expect, it } from "vitest";

import {
  clampCommandSelection,
  getSlashCommandSuggestions,
  moveCommandSelection,
} from "../../src/tui/overlays/command-palette.js";

describe("slash command palette", () => {
  it("lists only real interactive commands for a bare slash", () => {
    const commands = getSlashCommandSuggestions("/").map(
      ({ command }) => command,
    );

    expect(commands).toEqual([
      "/help",
      "/login",
      "/logout",
      "/model",
      "/new",
      "/resume",
      "/sessions",
      "/compact",
      "/status",
      "/clear",
      "/exit",
    ]);
  });

  it("filters prefixes and closes suggestions after an argument starts", () => {
    expect(
      getSlashCommandSuggestions("/m").map(({ command }) => command),
    ).toEqual(["/model"]);
    expect(getSlashCommandSuggestions("/model ")).toEqual([]);
    expect(getSlashCommandSuggestions("ordinary text")).toEqual([]);
  });

  it("exposes completions for commands that accept an argument", () => {
    const model = getSlashCommandSuggestions("/mod")[0];
    const status = getSlashCommandSuggestions("/sta")[0];

    expect(model).toMatchObject({
      command: "/model",
      completion: "/model ",
    });
    expect(status).toMatchObject({
      command: "/status",
      completion: "/status",
    });
  });

  it("wraps keyboard selection and safely clamps stale indices", () => {
    expect(moveCommandSelection(0, -1, 3)).toBe(2);
    expect(moveCommandSelection(2, 1, 3)).toBe(0);
    expect(clampCommandSelection(9, 3)).toBe(2);
    expect(clampCommandSelection(-1, 3)).toBe(0);
    expect(moveCommandSelection(4, 1, 0)).toBe(0);
  });
});
