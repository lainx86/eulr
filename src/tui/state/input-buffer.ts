export type CursorDirection = "left" | "right" | "up" | "down" | "home" | "end";

export interface SelectionRange {
  start: number;
  end: number;
}

export interface InputBufferSnapshot {
  value: string;
  cursor: number;
  selection: SelectionRange | null;
}

export interface InputBufferOptions {
  value?: string;
  cursor?: number;
  history?: readonly string[];
  historyLimit?: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class InputBuffer {
  private content: string;
  private cursorOffset: number;
  private selectionAnchor: number | null = null;
  private readonly historyLimit: number;
  private readonly historyEntries: string[];
  private historyIndex: number | null = null;
  private historyDraft: InputBufferSnapshot | null = null;
  private preferredColumn: number | null = null;

  constructor(options: InputBufferOptions | string = {}) {
    const normalized =
      typeof options === "string" ? { value: options } : options;
    this.content = normalized.value ?? "";
    this.cursorOffset = normalizeCursor(
      this.content,
      normalized.cursor ?? this.content.length,
    );
    this.historyLimit = Math.max(1, Math.floor(normalized.historyLimit ?? 100));
    this.historyEntries = [...(normalized.history ?? [])].slice(
      -this.historyLimit,
    );
  }

  get value(): string {
    return this.content;
  }

  get text(): string {
    return this.content;
  }

  get cursor(): number {
    return this.cursorOffset;
  }

  get length(): number {
    return this.content.length;
  }

  get selection(): SelectionRange | null {
    if (
      this.selectionAnchor === null ||
      this.selectionAnchor === this.cursorOffset
    ) {
      return null;
    }
    return {
      start: Math.min(this.selectionAnchor, this.cursorOffset),
      end: Math.max(this.selectionAnchor, this.cursorOffset),
    };
  }

  get selectedText(): string {
    const range = this.selection;
    return range === null ? "" : this.content.slice(range.start, range.end);
  }

  get history(): readonly string[] {
    return [...this.historyEntries];
  }

  snapshot(): InputBufferSnapshot {
    return {
      value: this.content,
      cursor: this.cursorOffset,
      selection: this.selection,
    };
  }

  setValue(value: string, cursor = value.length): this {
    this.content = value;
    this.cursorOffset = normalizeCursor(value, cursor);
    this.selectionAnchor = null;
    this.afterEdit();
    return this;
  }

  insert(text: string): this {
    if (text === "") return this;
    const range = this.selection;
    const start = range?.start ?? this.cursorOffset;
    const end = range?.end ?? this.cursorOffset;
    this.content =
      this.content.slice(0, start) + text + this.content.slice(end);
    this.cursorOffset = start + text.length;
    this.selectionAnchor = null;
    this.afterEdit();
    return this;
  }

  paste(text: string): this {
    return this.insert(text.replace(/\r\n?/g, "\n"));
  }

  newline(): this {
    return this.insert("\n");
  }

  moveCursor(direction: CursorDirection, select = false): this {
    switch (direction) {
      case "left":
        return this.moveLeft(select);
      case "right":
        return this.moveRight(select);
      case "up":
        return this.moveUp(select);
      case "down":
        return this.moveDown(select);
      case "home":
        return this.moveHome(select);
      case "end":
        return this.moveEnd(select);
    }
  }

  moveLeft(select = false): this {
    this.preferredColumn = null;
    if (!select && this.selection !== null) {
      return this.placeCursor(this.selection.start, false);
    }
    return this.placeCursor(
      previousGraphemeBoundary(this.content, this.cursorOffset),
      select,
    );
  }

  moveRight(select = false): this {
    this.preferredColumn = null;
    if (!select && this.selection !== null) {
      return this.placeCursor(this.selection.end, false);
    }
    return this.placeCursor(
      nextGraphemeBoundary(this.content, this.cursorOffset),
      select,
    );
  }

  moveUp(select = false): this {
    const currentStart = lineStart(this.content, this.cursorOffset);
    const column =
      this.preferredColumn ??
      graphemeCount(this.content.slice(currentStart, this.cursorOffset));
    this.preferredColumn = column;
    if (currentStart === 0) return this.placeCursor(this.cursorOffset, select);

    const previousEnd = currentStart - 1;
    const previousStart = lineStart(this.content, previousEnd);
    return this.placeCursor(
      offsetAtColumn(this.content, previousStart, previousEnd, column),
      select,
    );
  }

  moveDown(select = false): this {
    const currentStart = lineStart(this.content, this.cursorOffset);
    const column =
      this.preferredColumn ??
      graphemeCount(this.content.slice(currentStart, this.cursorOffset));
    this.preferredColumn = column;
    const currentEnd = lineEnd(this.content, this.cursorOffset);
    if (currentEnd === this.content.length) {
      return this.placeCursor(this.cursorOffset, select);
    }

    const nextStart = currentEnd + 1;
    const nextEnd = lineEnd(this.content, nextStart);
    return this.placeCursor(
      offsetAtColumn(this.content, nextStart, nextEnd, column),
      select,
    );
  }

  moveHome(select = false): this {
    this.preferredColumn = null;
    return this.placeCursor(lineStart(this.content, this.cursorOffset), select);
  }

  moveEnd(select = false): this {
    this.preferredColumn = null;
    return this.placeCursor(lineEnd(this.content, this.cursorOffset), select);
  }

  backspace(): this {
    if (this.deleteSelection()) return this;
    if (this.cursorOffset === 0) return this;

    const start = previousGraphemeBoundary(this.content, this.cursorOffset);
    this.content =
      this.content.slice(0, start) + this.content.slice(this.cursorOffset);
    this.cursorOffset = start;
    this.afterEdit();
    return this;
  }

  delete(): this {
    if (this.deleteSelection()) return this;
    if (this.cursorOffset === this.content.length) return this;

    const end = nextGraphemeBoundary(this.content, this.cursorOffset);
    this.content =
      this.content.slice(0, this.cursorOffset) + this.content.slice(end);
    this.afterEdit();
    return this;
  }

  selectAll(): this {
    this.selectionAnchor = 0;
    this.cursorOffset = this.content.length;
    this.preferredColumn = null;
    return this;
  }

  clearSelection(): this {
    this.selectionAnchor = null;
    return this;
  }

  historyUp(): this {
    if (this.historyEntries.length === 0) return this;
    if (this.historyIndex === null) {
      this.historyDraft = this.snapshot();
      this.historyIndex = this.historyEntries.length - 1;
    } else {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    }
    this.loadHistoryEntry(this.historyEntries[this.historyIndex] ?? "");
    return this;
  }

  historyDown(): this {
    if (this.historyIndex === null) return this;
    if (this.historyIndex < this.historyEntries.length - 1) {
      this.historyIndex += 1;
      this.loadHistoryEntry(this.historyEntries[this.historyIndex] ?? "");
      return this;
    }

    const draft = this.historyDraft;
    this.historyIndex = null;
    this.historyDraft = null;
    this.content = draft?.value ?? "";
    this.cursorOffset = draft?.cursor ?? this.content.length;
    this.selectionAnchor = null;
    this.preferredColumn = null;
    return this;
  }

  submit(): string {
    const submitted = this.content;
    if (submitted.trim() !== "" && this.historyEntries.at(-1) !== submitted) {
      this.historyEntries.push(submitted);
      if (this.historyEntries.length > this.historyLimit) {
        this.historyEntries.splice(
          0,
          this.historyEntries.length - this.historyLimit,
        );
      }
    }
    this.clear();
    return submitted;
  }

  clear(): this {
    this.content = "";
    this.cursorOffset = 0;
    this.selectionAnchor = null;
    this.historyIndex = null;
    this.historyDraft = null;
    this.preferredColumn = null;
    return this;
  }

  private placeCursor(offset: number, select: boolean): this {
    const target = normalizeCursor(this.content, offset);
    if (select) {
      const anchor = this.selectionAnchor ?? this.cursorOffset;
      this.cursorOffset = target;
      this.selectionAnchor = anchor === target ? null : anchor;
    } else {
      this.cursorOffset = target;
      this.selectionAnchor = null;
    }
    return this;
  }

  private deleteSelection(): boolean {
    const range = this.selection;
    if (range === null) return false;
    this.content =
      this.content.slice(0, range.start) + this.content.slice(range.end);
    this.cursorOffset = range.start;
    this.selectionAnchor = null;
    this.afterEdit();
    return true;
  }

  private afterEdit(): void {
    this.historyIndex = null;
    this.historyDraft = null;
    this.preferredColumn = null;
  }

  private loadHistoryEntry(value: string): void {
    this.content = value;
    this.cursorOffset = value.length;
    this.selectionAnchor = null;
    this.preferredColumn = null;
  }
}

function normalizeCursor(value: string, offset: number): number {
  const target = Math.max(0, Math.min(value.length, Math.floor(offset)));
  let boundary = 0;
  for (const segment of graphemes.segment(value)) {
    if (segment.index > target) break;
    boundary = segment.index;
    const end = segment.index + segment.segment.length;
    if (end <= target) boundary = end;
    if (end >= target) break;
  }
  return boundary;
}

function previousGraphemeBoundary(value: string, offset: number): number {
  if (offset <= 0) return 0;
  let previous = 0;
  for (const segment of graphemes.segment(value)) {
    if (segment.index >= offset) break;
    previous = segment.index;
  }
  return previous;
}

function nextGraphemeBoundary(value: string, offset: number): number {
  for (const segment of graphemes.segment(value)) {
    const end = segment.index + segment.segment.length;
    if (end > offset) return end;
  }
  return value.length;
}

function lineStart(value: string, offset: number): number {
  return value.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function lineEnd(value: string, offset: number): number {
  const newline = value.indexOf("\n", offset);
  return newline === -1 ? value.length : newline;
}

function graphemeCount(value: string): number {
  let count = 0;
  for (const _segment of graphemes.segment(value)) count += 1;
  return count;
}

function offsetAtColumn(
  value: string,
  start: number,
  end: number,
  column: number,
): number {
  if (column <= 0) return start;
  let count = 0;
  for (const segment of graphemes.segment(value.slice(start, end))) {
    count += 1;
    if (count === column) {
      return start + segment.index + segment.segment.length;
    }
  }
  return end;
}
