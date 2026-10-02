import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import { composerProps, conversation } from "./composer-fixtures";

afterEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });

it("keeps the message and its images when the provider refuses its image budget", async () => {
  const images: ChatAttachment[] = ["first", "second", "third"].map((id) => ({
    id, path: id, name: `${id}.png`, mimeType: "image/png", size: 8 * 1024 * 1024,
  }));
  const onImportAttachments = vi.fn(async () => ({
    attachments: images, commit: async () => undefined, cancel: async () => undefined,
  }));
  const refusal = "Claude accepts at most 20 MiB of images per message. Remove some images and send again.";
  const onSend = vi.fn(async () => { throw new Error(refusal); });
  render(<Composer {...composerProps(conversation("provider-image-budget"), { onImportAttachments, onSend })} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.drop(screen.getByLabelText("Message composer"), {
    dataTransfer: { files: images.map(({ name }) => new File(["image"], name, { type: "image/png" })), types: ["Files"] },
  });
  await screen.findByText("third.png");
  fireEvent.change(input, { target: { value: "Compare these screenshots." } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  await waitFor(() => expect(input).toHaveValue("Compare these screenshots."));
  for (const { name } of images) expect(screen.getByText(name)).toBeInTheDocument();
  expect(onSend).toHaveBeenCalledWith("Compare these screenshots.", images, undefined);
});
