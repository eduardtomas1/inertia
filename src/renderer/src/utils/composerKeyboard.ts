import {
  isSidebarNavigationKey,
  type SidebarNavigationKey,
} from "./sidebarModel";

export interface ComposerSubmitKeyEvent {
  key: string;
  shiftKey: boolean;
  nativeEvent: {
    isComposing: boolean;
    keyCode: number;
  };
}

export interface ComposerPromptHistoryKeyEvent extends ComposerSubmitKeyEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface ComposerPromptHistorySelection {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function composerPromptHistoryDirection(
  event: ComposerPromptHistoryKeyEvent,
  selection: ComposerPromptHistorySelection,
): "previous" | "next" | null {
  if (
    (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    || event.shiftKey
    || event.ctrlKey
    || event.metaKey
    || event.altKey
    || event.nativeEvent.isComposing
    || event.nativeEvent.keyCode === 229
    || selection.selectionStart !== selection.selectionEnd
  ) return null;

  if (!selection.value.includes("\n")) {
    return event.key === "ArrowUp" ? "previous" : "next";
  }
  if (event.key === "ArrowUp" && selection.selectionStart === 0) {
    return "previous";
  }
  if (
    event.key === "ArrowDown"
    && selection.selectionEnd === selection.value.length
  ) return "next";
  return null;
}

/**
 * Key code 229 is retained for Chromium/IME combinations that report the
 * composition-end Enter before `isComposing` has cleared consistently.
 */
export function shouldSubmitComposerKey(
  event: ComposerSubmitKeyEvent,
): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.nativeEvent.isComposing
    && event.nativeEvent.keyCode !== 229;
}

interface ComposerSuggestionKeyEvent extends ComposerSubmitKeyEvent {
  preventDefault(): void;
  stopPropagation(): void;
}

export function handleComposerSuggestionKey(
  event: ComposerSuggestionKeyEvent,
  dismiss: () => void,
  move: (key: SidebarNavigationKey) => void,
  accept?: () => void,
  acceptEnter = true,
): boolean {
  if (event.key === "Escape") {
    event.stopPropagation();
    dismiss();
  } else if (isSidebarNavigationKey(event.key)) {
    move(event.key);
  } else if (accept && (
    (event.key === "Tab" && !event.shiftKey)
    || (acceptEnter && shouldSubmitComposerKey(event))
  )) {
    accept();
  } else {
    return false;
  }
  event.preventDefault();
  return true;
}
