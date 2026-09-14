import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewNoteDialog } from "../../src/renderer/src/components/ReviewNoteDialog";

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
