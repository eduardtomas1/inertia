export interface ComposerSubmitKeyEvent {
  key: string;
  shiftKey: boolean;
  nativeEvent: {
    isComposing: boolean;
    keyCode: number;
  };
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
