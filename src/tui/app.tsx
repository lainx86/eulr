import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useCursor, useInput, usePaste, useWindowSize } from "ink";

import { computeLayout } from "./layout/constraints.js";
import { RootLayout } from "./layout/root-layout.js";
import { InputBuffer, type InputBufferSnapshot } from "./state/input-buffer.js";
import type { TuiStore } from "./state/tui-store.js";
import type { TuiController } from "./tui-controller.js";

export function TuiApp({
  store,
  controller,
  initialTask,
}: {
  store: TuiStore;
  controller: TuiController;
  initialTask?: string;
}): React.JSX.Element {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const { columns, rows } = useWindowSize();
  const { exit, suspendTerminal } = useApp();
  const { setCursorPosition } = useCursor();
  const buffer = useRef(new InputBuffer());
  const [input, setInput] = useState<InputBufferSnapshot>(() =>
    buffer.current.snapshot(),
  );
  const initialTaskStarted = useRef(false);

  const refreshInput = (): void => setInput(buffer.current.snapshot());

  useEffect(() => {
    controller.bindApp({
      exit: (error) => exit(error),
      suspendTerminal,
    });
  }, [controller, exit, suspendTerminal]);

  useEffect(() => {
    void controller.loadModelCatalog();
  }, [controller]);

  useEffect(() => {
    const timer = setInterval(() => store.tick(), 250);
    timer.unref();
    return () => clearInterval(timer);
  }, [store]);

  useEffect(() => {
    if (initialTask === undefined || initialTaskStarted.current) return;
    initialTaskStarted.current = true;
    controller.submit(initialTask);
  }, [controller, initialTask]);

  const layout = computeLayout(columns, rows);
  useEffect(() => {
    if (
      state.focus !== "input" ||
      state.permission !== undefined ||
      state.overlay !== undefined ||
      layout.input.height < 2
    ) {
      setCursorPosition(undefined);
      return;
    }
    const prefixWidth = 7;
    const editableWidth = Math.max(1, layout.input.width - prefixWidth - 4);
    const beforeCursor = input.value.slice(0, input.cursor);
    const logicalLines = beforeCursor.split("\n");
    const lastLine = logicalLines.at(-1) ?? "";
    const wrappedRows = Math.floor(lastLine.length / editableWidth);
    const row = Math.min(
      Math.max(0, layout.input.height - 3),
      logicalLines.length - 1 + wrappedRows,
    );
    setCursorPosition({
      x: Math.min(
        layout.input.width - 2,
        prefixWidth + 2 + (lastLine.length % editableWidth),
      ),
      y: layout.input.y + 1 + row,
    });
    return () => setCursorPosition(undefined);
  }, [
    input,
    layout.input,
    setCursorPosition,
    state.focus,
    state.overlay,
    state.permission,
  ]);

  usePaste((text) => {
    if (state.permission !== undefined || state.overlay !== undefined) return;
    store.setFocus("input");
    buffer.current.paste(text);
    refreshInput();
  });

  useInput((value, key) => {
    if (state.permission !== undefined) {
      if (key.escape || value.toLowerCase() === "n")
        controller.resolvePermission("deny");
      else if (value.toLowerCase() === "y")
        controller.resolvePermission("allow_once");
      else if (value.toLowerCase() === "a")
        controller.resolvePermission("allow_session");
      return;
    }

    if (state.overlay !== undefined) {
      if (key.escape) controller.closeOverlay();
      else if (key.upArrow) store.moveOverlaySelection(-1);
      else if (key.downArrow) store.moveOverlaySelection(1);
      else if (key.return) void controller.confirmOverlaySelection();
      return;
    }

    if (key.ctrl && value.toLowerCase() === "c") {
      controller.interrupt();
      return;
    }
    if (key.ctrl && value.toLowerCase() === "l") {
      controller.redraw();
      return;
    }
    if (key.tab) {
      store.cycleFocus(key.shift);
      return;
    }
    if (key.escape) {
      if (state.phase === "working") controller.interrupt();
      else store.setFocus("input");
      return;
    }
    if (key.pageUp || key.pageDown) {
      store.scrollFocused(key.pageUp ? -8 : 8);
      return;
    }
    if (key.home && state.focus !== "input") {
      store.scrollHome();
      return;
    }
    if (key.end && state.focus !== "input") {
      store.scrollEnd();
      return;
    }

    if (
      state.focus === "music" &&
      handleMusicInput(value, key, state.music, controller)
    ) {
      return;
    }
    if (state.focus === "inspector") {
      if (key.leftArrow || key.rightArrow) {
        store.cycleInspector(key.leftArrow);
        return;
      }
      if (key.upArrow || key.downArrow) {
        store.scrollFocused(key.upArrow ? -1 : 1);
        return;
      }
    }
    if (state.focus === "activity" && (key.upArrow || key.downArrow)) {
      store.scrollFocused(key.upArrow ? -1 : 1);
      return;
    }

    if (value === "?" && buffer.current.value === "") {
      store.setOverlay({ type: "help" });
      return;
    }

    store.setFocus("input");
    if (key.return) {
      if (key.shift || key.meta) buffer.current.newline();
      else {
        const submitted = buffer.current.submit();
        controller.submit(submitted);
      }
      refreshInput();
      return;
    }
    if (key.backspace) buffer.current.backspace();
    else if (key.delete) buffer.current.delete();
    else if (key.leftArrow) buffer.current.moveLeft(key.shift);
    else if (key.rightArrow) buffer.current.moveRight(key.shift);
    else if (key.home) buffer.current.moveHome(key.shift);
    else if (key.end) buffer.current.moveEnd(key.shift);
    else if (key.upArrow) {
      if (key.ctrl || !buffer.current.value.includes("\n"))
        buffer.current.historyUp();
      else buffer.current.moveUp(key.shift);
    } else if (key.downArrow) {
      if (key.ctrl || !buffer.current.value.includes("\n"))
        buffer.current.historyDown();
      else buffer.current.moveDown(key.shift);
    } else if (key.ctrl && value.toLowerCase() === "a")
      buffer.current.selectAll();
    else if (key.ctrl && value.toLowerCase() === "p")
      buffer.current.historyUp();
    else if (key.ctrl && value.toLowerCase() === "n")
      buffer.current.historyDown();
    else if (!key.ctrl && !key.meta && value !== "")
      buffer.current.insert(value);
    refreshInput();
  });

  return <RootLayout state={state} input={input} layout={layout} />;
}

function handleMusicInput(
  value: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  music: ReturnType<TuiStore["getSnapshot"]>["music"],
  controller: TuiController,
): boolean {
  const lower = value.toLowerCase();
  if (key.escape) return false;
  if (value === " ") void controller.musicKey({ type: "toggle" });
  else if (key.leftArrow)
    void controller.musicKey({
      type: "seek",
      seconds: Math.max(0, music.elapsedSeconds - 5),
    });
  else if (key.rightArrow)
    void controller.musicKey({
      type: "seek",
      seconds: music.elapsedSeconds + 5,
    });
  else if (key.upArrow)
    void controller.musicKey({
      type: "volume",
      volume: Math.min(100, music.volume + 5),
    });
  else if (key.downArrow)
    void controller.musicKey({
      type: "volume",
      volume: Math.max(0, music.volume - 5),
    });
  else if (lower === "n") void controller.musicKey({ type: "next" });
  else if (lower === "p") void controller.musicKey({ type: "previous" });
  else if (lower === "s") void controller.musicKey({ type: "shuffle" });
  else if (lower === "r") void controller.musicKey({ type: "repeat" });
  else return false;
  return true;
}
