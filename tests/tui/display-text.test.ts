import { describe, expect, it } from "vitest";

import { displayLine, displayText } from "../../src/tui/display-text.js";

describe("TUI display text normalization", () => {
  it("expands tabs and converts carriage returns into stable lines", () => {
    const normalized = displayText("\tconst value = 1;\rnext\r\n\tbaz");

    expect(normalized).toBe("    const value = 1;\nnext\n    baz");
    expect(normalized).not.toMatch(/[\t\r]/u);
  });

  it("keeps single-row labels on one terminal row", () => {
    expect(displayLine("Reading\tfile.ts\rsecond line")).toBe(
      "Reading file.ts ↵ second line",
    );
  });

  it("preserves credential redaction", () => {
    expect(displayText("Authorization: Bearer secret-value")).toBe(
      "Authorization: [REDACTED]",
    );
  });
});
