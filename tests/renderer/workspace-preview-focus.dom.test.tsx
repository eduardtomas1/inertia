import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewPanel } from "../../src/renderer/src/components/PreviewPanel";
import {
  focusWorkspacePreviewAddress,
  registerWorkspacePreviewAddress,
  routeWorkspaceRunPreview,
} from "../../src/renderer/src/utils/workspacePreviewFocus";

afterEach(() => {
  window.dispatchEvent(new Event("blur"));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function address(parent: HTMLElement = document.body): HTMLInputElement {
  const input = document.createElement("input");
  input.setAttribute("aria-label", "Preview address");
  parent.append(input);
  return input;
}

describe("workspace preview focus", () => {
  it("routes primary and sibling service previews to their owning pane", () => {
    const openPrimary = vi.fn();
    const openSecondary = vi.fn();
    const primary = { id: "primary-run", conversationId: "primary-chat" };
    const sibling = { id: "sibling-run", conversationId: "secondary-chat" };

    routeWorkspaceRunPreview(
      primary,
      "secondary-chat",
      openPrimary,
      openSecondary,
    );
    routeWorkspaceRunPreview(
      sibling,
      "secondary-chat",
      openPrimary,
      openSecondary,
    );

    expect(openPrimary).toHaveBeenCalledWith(primary);
    expect(openSecondary).toHaveBeenCalledWith(sibling);
  });

  it("focuses the standalone primary preview address", () => {
    const input = address();

    focusWorkspacePreviewAddress("primary");

    expect(input).toHaveFocus();
  });

  it("focuses only the requested split owner", () => {
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
    const fallback = document.createElement("button");
    document.body.append(fallback);
    address();
    fallback.focus();

    focusWorkspacePreviewAddress("secondary");

    expect(fallback).toHaveFocus();
  });

  it("waits for the lazy preview address to mount", () => {
    focusWorkspacePreviewAddress("primary");
    const input = address();
    registerWorkspacePreviewAddress("primary", input);

    expect(input).toHaveFocus();
  });

  it("focuses the address when the preview surface mounts", () => {
    focusWorkspacePreviewAddress("primary");

    const preview = render(
      <PreviewPanel
        owner="primary"
        url="http://127.0.0.1:4173/"
        onNavigate={() => undefined}
        onOpenExternal={() => undefined}
      />,
    );

    expect(preview.getByRole("textbox", { name: "Preview address" }))
      .toHaveFocus();
  });

  it("waits for the requested split owner's preview address", () => {
    focusWorkspacePreviewAddress("secondary");
    const primary = address();
    registerWorkspacePreviewAddress("primary", primary);
    const secondary = address();
    registerWorkspacePreviewAddress("secondary", secondary);

    expect(primary).not.toHaveFocus();
    expect(secondary).toHaveFocus();
  });

  it("does not steal focus while waiting for a lazy preview address", () => {
    const fallback = document.createElement("button");
    document.body.append(fallback);

    focusWorkspacePreviewAddress("primary");
    fallback.focus();
    const input = address();
    registerWorkspacePreviewAddress("primary", input);

    expect(fallback).toHaveFocus();
    expect(input).not.toHaveFocus();
  });
});
