import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComposerAttachmentList } from "../../src/renderer/src/components/ComposerAttachmentList";
import type { ChatAttachment } from "../../src/shared/contracts";
import {
  NATIVE_PREVIEW_OVERLAY_CLOSED,
  NATIVE_PREVIEW_OVERLAY_OPENED,
} from "../../src/renderer/src/utils/nativePreviewOverlay";

const image: ChatAttachment = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "preview.png",
  path: "/private/tmp/preview.png",
  mimeType: "image/png",
  size: 1_024,
};

describe("attachment preview dialog", () => {
  it("opens an accessible image lightbox and restores focus after Escape", async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    const closed = vi.fn();
    window.addEventListener(NATIVE_PREVIEW_OVERLAY_OPENED, opened);
    window.addEventListener(NATIVE_PREVIEW_OVERLAY_CLOSED, closed);
    render(
      <ComposerAttachmentList
        attachments={[image]}
        onRemove={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Preview attachment preview.png",
    });

    await user.click(trigger);

    const dialog = await screen.findByRole(
      "dialog",
      { name: "preview.png" },
      { timeout: 10_000 },
    );
    expect(opened).toHaveBeenCalledOnce();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("img", { name: "preview.png" }))
      .toHaveAttribute(
        "src",
        "inertia://bundle/attachment-preview/11111111-1111-4111-8111-111111111111",
      );
    await waitFor(() => {
      expect(screen.getByRole("button", {
        name: "Close preview of preview.png",
      })).toHaveFocus();
    });

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "preview.png" }))
      .not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(closed).toHaveBeenCalledOnce();
    window.removeEventListener(NATIVE_PREVIEW_OVERLAY_OPENED, opened);
    window.removeEventListener(NATIVE_PREVIEW_OVERLAY_CLOSED, closed);
  });
});
