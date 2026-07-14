import { describe, expect, it } from "vitest";

import { InputBuffer } from "../../src/tui/state/input-buffer.js";

describe("InputBuffer", () => {
  it("inserts text, normalized paste, and newlines at the cursor", () => {
    const buffer = new InputBuffer("ab");

    buffer.moveLeft().insert("X").newline().paste("c\r\nd");

    expect(buffer.value).toBe("aX\nc\ndb");
    expect(buffer.cursor).toBe("aX\nc\nd".length);
  });

  it("moves by grapheme and deletes whole grapheme clusters", () => {
    const value = "a👩‍💻b";
    const backward = new InputBuffer({ value, cursor: value.length - 1 });
    const forward = new InputBuffer({ value, cursor: 1 });

    backward.backspace();
    forward.delete();

    expect(backward.snapshot()).toEqual({
      value: "ab",
      cursor: 1,
      selection: null,
    });
    expect(forward.snapshot()).toEqual({
      value: "ab",
      cursor: 1,
      selection: null,
    });
  });

  it("supports shift selection, replacement, backspace, and delete", () => {
    const replacement = new InputBuffer("hello");
    replacement.moveLeft(true).moveLeft(true);

    expect(replacement.selectedText).toBe("lo");
    replacement.insert("!");
    expect(replacement.snapshot()).toEqual({
      value: "hel!",
      cursor: 4,
      selection: null,
    });

    const deletion = new InputBuffer("hello");
    deletion.moveLeft(true).moveLeft(true).backspace();
    expect(deletion.value).toBe("hel");

    deletion.moveHome().delete();
    expect(deletion.value).toBe("el");
  });

  it("moves home, end, up, and down within multiline input", () => {
    const buffer = new InputBuffer({ value: "ab\ncde\nx", cursor: 5 });

    buffer.moveHome();
    expect(buffer.cursor).toBe(3);
    buffer.moveEnd();
    expect(buffer.cursor).toBe(6);

    buffer.moveLeft().moveUp();
    expect(buffer.cursor).toBe(2);
    buffer.moveDown();
    expect(buffer.cursor).toBe(5);
  });

  it("walks history, restores the draft, and records submissions", () => {
    const buffer = new InputBuffer({
      value: "draft",
      cursor: 2,
      history: ["one", "two"],
    });

    buffer.historyUp();
    expect(buffer.value).toBe("two");
    buffer.historyUp();
    expect(buffer.value).toBe("one");
    buffer.historyDown();
    expect(buffer.value).toBe("two");
    buffer.historyDown();
    expect(buffer.snapshot()).toEqual({
      value: "draft",
      cursor: 2,
      selection: null,
    });

    expect(buffer.submit()).toBe("draft");
    expect(buffer.value).toBe("");
    expect(buffer.history).toEqual(["one", "two", "draft"]);
  });

  it("limits history and avoids consecutive duplicate submissions", () => {
    const buffer = new InputBuffer({ historyLimit: 2 });

    buffer.insert("one").submit();
    buffer.insert("two").submit();
    buffer.insert("two").submit();
    buffer.insert("three").submit();

    expect(buffer.history).toEqual(["two", "three"]);
  });
});
