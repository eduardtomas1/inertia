import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SentMessageAttachmentList } from "../../src/renderer/src/components/SentMessageAttachmentList";
import type { ChatAttachment } from "../../src/shared/contracts";

const image: ChatAttachment = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "a-very-long-reference-image-name-that-needs-truncation.png",
  path: "/private/path-must-not-render/reference.png",
  mimeType: "image/png",
  size: 1_024,
};

const text: ChatAttachment = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "evidence.json",
  path: "/private/path-must-not-render/evidence.json",
  mimeType: "application/json",
  size: 2_048,
};

describe("sent message attachments", () => {
  it("renders no attachment region for an empty projection", () => {
    const { container } = render(
      <SentMessageAttachmentList attachments={[]} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("list", { name: "Message attachments" }))
      .not.toBeInTheDocument();
  });

  it("keeps image previews and document metadata visible without local paths", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SentMessageAttachmentList attachments={[image, text]} />,
    );
    const trigger = screen.getByRole("button", {
      name: `Preview attachment ${image.name}`,
    });
    const thumbnail = trigger.querySelector(".sent-attachment-thumbnail");
    const thumbnailImage = trigger.querySelector("img");

    expect(screen.getByRole("list", { name: "Message attachments" }))
      .toBeInTheDocument();
    expect(thumbnailImage).toHaveAttribute(
      "src",
      `inertia://bundle/attachment-preview/${image.id}`,
    );
    expect(thumbnail).toHaveAttribute("data-thumbnail-state", "loading");
    expect(trigger.querySelector("strong")).toHaveAttribute(
      "title",
      image.name,
    );
    expect(trigger).toHaveAccessibleDescription("PNG image · 1.0 KB");
    expect(screen.getByRole("button", { name: "Preview attachment evidence.json" }))
      .toHaveTextContent("JSON document · 2.0 KB");
    expect(screen.getByRole("button", { name: "Preview attachment evidence.json" }))
      .toHaveAccessibleDescription("JSON document · 2.0 KB");
    expect(container.textContent).not.toContain("/private/");

    fireEvent.error(thumbnailImage!);
    expect(thumbnail).toHaveAttribute("data-thumbnail-state", "unavailable");
    expect(thumbnail?.querySelector(".lucide-image-off")).not.toBeNull();

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: image.name }))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", {
        name: `Close preview of ${image.name}`,
      })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("marks a loaded thumbnail ready while preserving its bounded card", () => {
    render(<SentMessageAttachmentList attachments={[image]} />);
    const thumbnailImage = screen.getByRole("button", {
      name: `Preview attachment ${image.name}`,
    }).querySelector("img")!;

    fireEvent.load(thumbnailImage);

    expect(thumbnailImage.parentElement)
      .toHaveAttribute("data-thumbnail-state", "ready");
  });
});
