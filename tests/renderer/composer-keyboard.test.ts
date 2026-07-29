import { describe, expect, it } from "vitest";

import { shouldSubmitComposerKey } from "../../src/renderer/src/utils/composerKeyboard";

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
