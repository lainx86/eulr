export type LayoutMode = "full" | "compact" | "minimum";

export interface LayoutRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuiLayout {
  mode: LayoutMode;
  width: number;
  height: number;
  main: LayoutRegion;
  input: LayoutRegion;
  dock: LayoutRegion;
}

const RESERVED_HEIGHTS: Record<LayoutMode, { input: number; dock: number }> = {
  full: { input: 4, dock: 8 },
  compact: { input: 4, dock: 6 },
  minimum: { input: 3, dock: 4 },
};

export function computeLayout(width: number, height: number): TuiLayout {
  const safeWidth = normalizeDimension(width);
  const safeHeight = normalizeDimension(height);
  const mode = selectMode(safeWidth, safeHeight);
  const reserved = RESERVED_HEIGHTS[mode];

  const minimumMainHeight = safeHeight > 0 ? 1 : 0;
  const inputHeight = Math.min(
    reserved.input,
    Math.max(0, safeHeight - minimumMainHeight),
  );
  const dockHeight = Math.min(
    reserved.dock,
    Math.max(0, safeHeight - minimumMainHeight - inputHeight),
  );
  const mainHeight = safeHeight - inputHeight - dockHeight;

  const main: LayoutRegion = {
    x: 0,
    y: 0,
    width: safeWidth,
    height: mainHeight,
  };
  const input: LayoutRegion = {
    x: 0,
    y: main.y + main.height,
    width: safeWidth,
    height: inputHeight,
  };
  const dock: LayoutRegion = {
    x: 0,
    y: input.y + input.height,
    width: safeWidth,
    height: dockHeight,
  };

  return {
    mode,
    width: safeWidth,
    height: safeHeight,
    main,
    input,
    dock,
  };
}

function selectMode(width: number, height: number): LayoutMode {
  if (width >= 120 && height >= 34) return "full";
  if (width >= 90 && height >= 12) return "compact";
  return "minimum";
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
