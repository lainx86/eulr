import { createElement } from "react";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";

import { ActivityPanel } from "../../src/tui/panels/activity-panel.js";
import { OutputView } from "../../src/tui/panels/output-view.js";

describe("panel render isolation", () => {
  it("uses stable output keys while the viewport is pinned to the end", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const output = renderToString(
      createElement(OutputView, {
        output: {
          command: "generate output",
          stdout: `${"same line\n".repeat(80)}`,
          stderr: "",
          running: true,
        },
        width: 70,
        height: 20,
        vertical: Number.MAX_SAFE_INTEGER,
        horizontal: 0,
      }),
      { columns: 70 },
    );

    expect(consoleError).not.toHaveBeenCalled();
    expect(output.split("\n").length).toBeLessThanOrEqual(20);
  });

  it("keeps activity keys unique even when event IDs are duplicated", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const repeatedActivity = {
      id: "same-event",
      label: "Reading file.ts",
      detail: "Read one line",
      status: "completed" as const,
      timestamp: 1,
    };

    renderToString(
      createElement(ActivityPanel, {
        activities: [repeatedActivity, repeatedActivity],
        height: 12,
        width: 60,
        offset: Number.MAX_SAFE_INTEGER,
        active: true,
        frame: 0,
      }),
      { columns: 60 },
    );

    expect(consoleError).not.toHaveBeenCalled();
  });
});
