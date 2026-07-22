import { describe, expect, it } from "vitest";

import { computeLayout } from "../../src/tui/layout/constraints.js";

describe("computeLayout", () => {
  it("selects full, compact, and minimum modes at their boundaries", () => {
    expect(computeLayout(120, 34).mode).toBe("full");
    expect(computeLayout(120, 33).mode).toBe("compact");
    expect(computeLayout(90, 20).mode).toBe("compact");
    expect(computeLayout(140, 11).mode).toBe("minimum");
    expect(computeLayout(89, 50).mode).toBe("minimum");
  });

  it.each([
    [160, 50],
    [100, 30],
    [80, 24],
    [1, 2],
    [0, 0],
  ])("keeps main, input, and dock vertically ordered at %ix%i", (w, h) => {
    const layout = computeLayout(w, h);

    expect(layout.main.y).toBe(0);
    expect(layout.input.y).toBe(layout.main.y + layout.main.height);
    expect(layout.dock.y).toBe(layout.input.y + layout.input.height);
    expect(layout.dock.y + layout.dock.height).toBe(layout.height);
    expect(layout.main.height).toBeGreaterThanOrEqual(0);
    expect(layout.input.height).toBeGreaterThanOrEqual(0);
    expect(layout.dock.height).toBeGreaterThanOrEqual(0);
  });

  it("reserves stable input and dock regions independent of task activity", () => {
    const idle = computeLayout(140, 42);
    const working = computeLayout(140, 42);

    expect(working.input).toEqual(idle.input);
    expect(working.dock).toEqual(idle.dock);
  });

  it("normalizes invalid dimensions without producing negative regions", () => {
    const layout = computeLayout(Number.NaN, -4.2);

    expect(layout).toMatchObject({ width: 0, height: 0, mode: "minimum" });
    expect(layout.main.height).toBe(0);
    expect(layout.input.height).toBe(0);
    expect(layout.dock.height).toBe(0);
  });
});
