import { afterEach, describe, expect, it, vi } from "vitest";

import { focusWorkspacePreviewAddress } from "../../src/renderer/src/utils/workspacePreviewFocus";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function address(parent: HTMLElement = document.body): HTMLInputElement {
  const input = document.createElement("input");
  input.setAttribute("aria-label", "Preview address");
  parent.append(input);
  return input;
}

function flushFocusFrame(): void {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
}

describe("workspace preview focus", () => {
  it("focuses the standalone primary preview address", () => {
    flushFocusFrame();
    const input = address();

    focusWorkspacePreviewAddress("primary");

    expect(input).toHaveFocus();
  });

  it("focuses only the requested split owner", () => {
    flushFocusFrame();
    const primary = document.createElement("section");
    primary.id = "primary-conversation-pane";
    const secondary = document.createElement("section");
    secondary.id = "secondary-conversation-pane";
    document.body.append(primary, secondary);
    const primaryInput = address(primary);
    const secondaryInput = address(secondary);
    primaryInput.focus();

    focusWorkspacePreviewAddress("secondary");

    expect(secondaryInput).toHaveFocus();
  });

  it("does not move focus when the requested split owner is unavailable", () => {
    flushFocusFrame();
    const fallback = document.createElement("button");
    document.body.append(fallback);
    address();
    fallback.focus();

    focusWorkspacePreviewAddress("secondary");

    expect(fallback).toHaveFocus();
  });
});
