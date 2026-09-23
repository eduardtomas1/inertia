import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComposerAttachmentList } from "../../src/renderer/src/components/ComposerAttachmentList";
import type { ChatAttachment } from "../../src/shared/contracts";

const image: ChatAttachment = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "diagram.png",
  path: "/private/tmp/diagram.png",
  mimeType: "image/png",
  size: 4_096,
};

async function openZoomStage(): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<ComposerAttachmentList attachments={[image]} onRemove={vi.fn()} />);
  await user.click(screen.getByRole("button", {
    name: "Preview attachment diagram.png",
  }));
  return await screen.findByRole(
    "group",
    { name: "Zoomable preview of diagram.png" },
    { timeout: 10_000 },
  );
}

describe("attachment image zoom", () => {
  it("zooms with the controls and restores the fitted view", async () => {
    const user = userEvent.setup();
    const stage = await openZoomStage();
    const zoomIn = within(stage).getByRole("button", { name: "Zoom in" });
    const zoomOut = within(stage).getByRole("button", { name: "Zoom out" });
    const reset = within(stage).getByRole("button", { name: "Reset zoom" });
    const level = within(stage).getByLabelText("Zoom level");

    expect(level).toHaveTextContent("100%");
    expect(stage).toHaveAttribute("data-zoomed", "false");
    // Nothing to undo at the fitted scale.
    expect(zoomOut).toBeDisabled();
    expect(reset).toBeDisabled();

    await user.click(zoomIn);

    expect(level).toHaveTextContent("150%");
    expect(stage).toHaveAttribute("data-zoomed", "true");
    expect(zoomOut).toBeEnabled();
    expect(within(stage).getByRole("img", { name: "diagram.png" }))
      .toHaveStyle({ transform: "translate3d(0px, 0px, 0) scale(1.5)" });

    await user.click(zoomIn);
    expect(level).toHaveTextContent("225%");

    await user.click(reset);

    expect(level).toHaveTextContent("100%");
    expect(stage).toHaveAttribute("data-zoomed", "false");
    expect(zoomOut).toBeDisabled();
  });

  it("zooms from the keyboard without swallowing the dialog's Escape", async () => {
    const stage = await openZoomStage();
    const level = within(stage).getByLabelText("Zoom level");

    fireEvent.keyDown(stage, { key: "+" });
    expect(level).toHaveTextContent("150%");

    fireEvent.keyDown(stage, { key: "-" });
    expect(level).toHaveTextContent("100%");

    fireEvent.keyDown(stage, { key: "+" });
    fireEvent.keyDown(stage, { key: "+" });
    expect(level).toHaveTextContent("225%");

    fireEvent.keyDown(stage, { key: "0" });
    expect(level).toHaveTextContent("100%");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("returns to the fitted view when the preview reopens", async () => {
    const user = userEvent.setup();
    const stage = await openZoomStage();
    await user.click(within(stage).getByRole("button", { name: "Zoom in" }));
    expect(within(stage).getByLabelText("Zoom level")).toHaveTextContent("150%");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", {
      name: "Preview attachment diagram.png",
    }));

    const reopened = await screen.findByRole("group", {
      name: "Zoomable preview of diagram.png",
    });
    expect(within(reopened).getByLabelText("Zoom level"))
      .toHaveTextContent("100%");
  });
});
