export const COLORS = Object.freeze({
  background: "#0b0b0a",
  surface: "#12110f",
  foreground: "#eeeae2",
  muted: "#9c978d",
  border: "#4a453d",
  borderStrong: "#725b2c",
  accent: "#d1a545",
  info: "#78a7c8",
  success: "#7eaa74",
  warning: "#d1a545",
  danger: "#d76a61",
  companion: "#86a18a",
});

export type ThemeColor = keyof typeof COLORS;

export const colors = COLORS;
