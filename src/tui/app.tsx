import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useInput, usePaste, useWindowSize } from "ink";

import { computeLayout } from "./layout/constraints.js";
import { RootLayout } from "./layout/root-layout.js";
import { InputBuffer, type InputBufferSnapshot } from "./state/input-buffer.js";
import type { TuiStore } from "./state/tui-store.js";
import type { TuiController } from "./tui-controller.js";
import {
  clampCommandSelection,
  getSlashCommandSuggestions,
  moveCommandSelection,
} from "./overlays/command-palette.js";

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
  const buffer = useRef(new InputBuffer());
  const [input, setInput] = useState<InputBufferSnapshot>(() =>
    buffer.current.snapshot(),
  );
  const [commandSelection, setCommandSelection] = useState(0);
  const [dismissedCommandInput, setDismissedCommandInput] = useState<
    string | undefined
  >();
  const initialTaskStarted = useRef(false);

  const refreshInput = (contentChanged = false): void => {
    setInput(buffer.current.snapshot());
    if (contentChanged) {
      setCommandSelection(0);
      setDismissedCommandInput(undefined);
    }
  };

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
  const commandSuggestions = getSlashCommandSuggestions(input.value);
  const commandPaletteVisible =
    state.focus === "input" &&
    state.permission === undefined &&
    state.overlay === undefined &&
    dismissedCommandInput !== input.value &&
    commandSuggestions.length > 0;
  const activeCommandIndex = clampCommandSelection(
    commandSelection,
    commandSuggestions.length,
  );
  const mainHeaderHeight = layout.main.height >= 5 ? 2 : 0;
  const workingContentHeight = Math.max(
    0,
    layout.main.height - mainHeaderHeight,
  );
  const focusedViewportHeight = Math.max(
    0,
    workingContentHeight - (layout.mode === "minimum" ? 1 : 0) - 5,
  );

  usePaste((text) => {
    if (state.permission !== undefined || state.overlay !== undefined) return;
    store.setFocus("input");
    buffer.current.paste(text);
    refreshInput(true);
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

    if (commandPaletteVisible) {
      if (key.escape) {
        setDismissedCommandInput(input.value);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setCommandSelection((selection) =>
          moveCommandSelection(
            selection,
            key.upArrow ? -1 : 1,
            commandSuggestions.length,
          ),
        );
        return;
      }
      const selectedCommand = commandSuggestions[activeCommandIndex];
      if (
        selectedCommand !== undefined &&
        (key.tab || (key.return && input.value !== selectedCommand.command))
      ) {
        buffer.current.setValue(selectedCommand.completion);
        refreshInput(true);
        return;
      }
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
      store.scrollFocused(key.pageUp ? -8 : 8, false, focusedViewportHeight);
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

    if (state.focus === "inspector") {
      if (key.leftArrow || key.rightArrow) {
        if (key.shift) {
          store.scrollFocused(key.leftArrow ? -4 : 4, true);
        } else {
          store.cycleInspector(key.leftArrow);
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        store.scrollFocused(key.upArrow ? -1 : 1, false, focusedViewportHeight);
        return;
      }
    }
    if (state.focus === "activity" && (key.upArrow || key.downArrow)) {
      store.scrollFocused(key.upArrow ? -1 : 1, false, focusedViewportHeight);
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
      refreshInput(true);
      return;
    }
    let contentChanged = false;
    if (key.backspace) {
      buffer.current.backspace();
      contentChanged = true;
    } else if (key.delete) {
      buffer.current.delete();
      contentChanged = true;
    } else if (key.leftArrow) buffer.current.moveLeft(key.shift);
    else if (key.rightArrow) buffer.current.moveRight(key.shift);
    else if (key.home) buffer.current.moveHome(key.shift);
    else if (key.end) buffer.current.moveEnd(key.shift);
    else if (key.upArrow) {
      if (key.ctrl || !buffer.current.value.includes("\n")) {
        buffer.current.historyUp();
        contentChanged = true;
      } else buffer.current.moveUp(key.shift);
    } else if (key.downArrow) {
      if (key.ctrl || !buffer.current.value.includes("\n")) {
        buffer.current.historyDown();
        contentChanged = true;
      } else buffer.current.moveDown(key.shift);
    } else if (key.ctrl && value.toLowerCase() === "a")
      buffer.current.selectAll();
    else if (key.ctrl && value.toLowerCase() === "p") {
      buffer.current.historyUp();
      contentChanged = true;
    } else if (key.ctrl && value.toLowerCase() === "n") {
      buffer.current.historyDown();
      contentChanged = true;
    } else if (!key.ctrl && !key.meta && value !== "") {
      buffer.current.insert(value);
      contentChanged = true;
    }
    refreshInput(contentChanged);
  });

  return (
    <RootLayout
      state={state}
      input={input}
      layout={layout}
      commandPalette={{
        visible: commandPaletteVisible,
        selectedIndex: activeCommandIndex,
      }}
    />
  );
}
