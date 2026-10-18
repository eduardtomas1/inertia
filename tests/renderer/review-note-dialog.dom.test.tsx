import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewNoteDialog } from "../../src/renderer/src/components/ReviewNoteDialog";
import { emulateDisabledFocusFixup } from "./support/focus-fixup";

describe("review note editing", () => {
  it("focuses the note and saves trimmed text", async () => {
    const save = vi.fn(async () => undefined);
    const close = vi.fn();
    render(<ReviewNoteDialog draft={{ title: "Add review note", body: "", save }} onClose={close} />);
    const input = screen.getByRole("textbox", { name: "Review note" });
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "  Keep this change  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith("Keep this change");
  });

  it("preserves an edited note after failure and permits retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("synthetic failure")).mockResolvedValue(undefined);
    const close = vi.fn();
    render(<ReviewNoteDialog draft={{ title: "Edit review note", body: "Original", save }} onClose={close} />);
    const input = screen.getByRole("textbox", { name: "Review note" });
    fireEvent.change(input, { target: { value: "Revised" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your text is still here");
    expect(input).toHaveValue("Revised");
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("returns focus to the note after a failed save disabled its controls", async () => {
    const stop = emulateDisabledFocusFixup();
    try {
      const save = vi.fn().mockRejectedValueOnce(new Error("synthetic failure"));
      render(<ReviewNoteDialog draft={{ title: "Edit review note", body: "Original", save }} onClose={vi.fn()} />);
      const input = screen.getByRole("textbox", { name: "Review note" });
      fireEvent.change(input, { target: { value: "Revised" } });
      const submit = screen.getByRole("button", { name: "Save note" });
      submit.focus();
      fireEvent.click(submit);
      expect(await screen.findByRole("alert")).toHaveTextContent("Your text is still here");
      await waitFor(() => expect(input).toHaveFocus());
    } finally {
      stop();
    }
  });

  it("cancels with Escape and restores the opener's focus", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const save = vi.fn();
    const close = vi.fn();
    const view = render(<ReviewNoteDialog draft={{ title: "Edit review note", body: "Original", save }} onClose={close} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
