import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { PdfAttachmentPreview } from "../../src/renderer/src/components/PdfAttachmentPreview";
import { emulateDisabledFocusFixup } from "./support/focus-fixup";

it("keeps focus on a PDF page button when it reaches the first or last page", async () => {
  const stop = emulateDisabledFocusFixup();
  try {
    const document = { numPages: 2, getPage: vi.fn(() => new Promise(() => undefined)) };
    const getDocument = vi.fn(() => ({ promise: Promise.resolve(document), destroy: vi.fn(async () => undefined) }));
    const loadAttachment = vi.fn(async () => ({ bytes: new Uint8Array(), getDocument }));
    await act(async () => {
      render(<PdfAttachmentPreview source="blob:report" title="report.pdf" onFailure={vi.fn()}
        loadAttachment={loadAttachment as never} prepareCanvas={vi.fn() as never} />);
    });
    const previous = screen.getByRole("button", { name: "Previous PDF page" });
    const next = screen.getByRole("button", { name: "Next PDF page" });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(previous).toHaveAttribute("aria-disabled", "true");

    next.focus();
    await act(async () => { fireEvent.click(next); });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    await act(async () => { fireEvent.click(next); });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  } finally {
    stop();
  }
});
