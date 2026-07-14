export interface TerminalSymbols {
  prompt: string;
  bullet: string;
  success: string;
  failure: string;
  warning: string;
  selected: string;
  divider: string;
  ellipsis: string;
}

export const SYMBOLS: Readonly<TerminalSymbols> = Object.freeze({
  prompt: ">",
  bullet: "●",
  success: "✓",
  failure: "✗",
  warning: "!",
  selected: "›",
  divider: "─",
  ellipsis: "…",
});

export const ASCII_SYMBOLS: Readonly<TerminalSymbols> = Object.freeze({
  prompt: ">",
  bullet: "*",
  success: "+",
  failure: "x",
  warning: "!",
  selected: ">",
  divider: "-",
  ellipsis: "...",
});

export function terminalSymbols(unicode = true): Readonly<TerminalSymbols> {
  return unicode ? SYMBOLS : ASCII_SYMBOLS;
}

export const symbols = SYMBOLS;
