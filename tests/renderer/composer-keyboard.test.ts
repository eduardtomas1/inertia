import { describe, expect, it } from "vitest";

import {
  composerPromptHistoryDirection,
  shouldSubmitComposerKey,
} from "../../src/renderer/src/utils/composerKeyboard";

function event(
  overrides: Partial<Parameters<typeof shouldSubmitComposerKey>[0]> = {},
): Parameters<typeof shouldSubmitComposerKey>[0] {
  return {
    key: "Enter",
    shiftKey: false,
    nativeEvent: {
      isComposing: false,
      keyCode: 13,
    },
    ...overrides,
  };
}

describe("composer keyboard submission", () => {
  it("submits ordinary Enter but preserves Shift+Enter", () => {
    expect(shouldSubmitComposerKey(event())).toBe(true);
    expect(shouldSubmitComposerKey(event({ shiftKey: true }))).toBe(false);
  });

  it("never sends the Enter used to confirm an IME composition", () => {
    expect(shouldSubmitComposerKey(event({
      nativeEvent: { isComposing: true, keyCode: 13 },
    }))).toBe(false);
    expect(shouldSubmitComposerKey(event({
      nativeEvent: { isComposing: false, keyCode: 229 },
    }))).toBe(false);
  });
});

describe("composer prompt history keyboard navigation", () => {
  const historyEvent = (
    key: "ArrowUp" | "ArrowDown",
    overrides: Partial<Parameters<typeof composerPromptHistoryDirection>[0]> = {},
  ): Parameters<typeof composerPromptHistoryDirection>[0] => ({
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false, keyCode: 38 },
    ...overrides,
  });

  it("uses plain arrows for single-line prompt history", () => {
    const selection = { value: "draft", selectionStart: 2, selectionEnd: 2 };
    expect(composerPromptHistoryDirection(
      historyEvent("ArrowUp"),
      selection,
    )).toBe("previous");
    expect(composerPromptHistoryDirection(
      historyEvent("ArrowDown"),
      selection,
    )).toBe("next");
  });

  it("preserves native multiline navigation away from text boundaries", () => {
    const value = "first\nsecond";
    expect(composerPromptHistoryDirection(historyEvent("ArrowUp"), {
      value,
      selectionStart: 8,
      selectionEnd: 8,
    })).toBeNull();
    expect(composerPromptHistoryDirection(historyEvent("ArrowDown"), {
      value,
      selectionStart: 2,
      selectionEnd: 2,
    })).toBeNull();
    expect(composerPromptHistoryDirection(historyEvent("ArrowUp"), {
      value,
      selectionStart: 0,
      selectionEnd: 0,
    })).toBe("previous");
    expect(composerPromptHistoryDirection(historyEvent("ArrowDown"), {
      value,
      selectionStart: value.length,
      selectionEnd: value.length,
    })).toBe("next");
  });

  it("ignores selections, modifiers, and IME composition", () => {
    const selection = { value: "draft", selectionStart: 0, selectionEnd: 1 };
    expect(composerPromptHistoryDirection(
      historyEvent("ArrowUp"),
      selection,
    )).toBeNull();
    expect(composerPromptHistoryDirection(
      historyEvent("ArrowUp", { ctrlKey: true }),
      { ...selection, selectionEnd: 0 },
    )).toBeNull();
    expect(composerPromptHistoryDirection(historyEvent("ArrowUp", {
      nativeEvent: { isComposing: true, keyCode: 38 },
    }), { ...selection, selectionEnd: 0 })).toBeNull();
    expect(composerPromptHistoryDirection(historyEvent("ArrowUp", {
      nativeEvent: { isComposing: false, keyCode: 229 },
    }), { ...selection, selectionEnd: 0 })).toBeNull();
  });
});
