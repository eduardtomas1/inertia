import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileEditorDialog } from "../../src/renderer/src/components/FileEditorDialog";

const file = {
  path: "src/example.ts",
  content: "export const value = 1;\n",
  truncated: false,
  language: "ts",
  contentDigest: "a".repeat(64),
  modifiedAt: "2026-07-29T10:00:00.000Z",
};

describe("FileEditorDialog", () => {
  it("saves the edited text against the exact preview digest", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async (
      path: string,
      content: string,
      expectedDigest: string,
    ) => ({
      ...file,
      path,
      content,
      contentDigest: expectedDigest,
    }));
    render(
      <FileEditorDialog file={file} onClose={onClose} onSave={onSave} />,
    );

    const editor = screen.getByRole("textbox", {
      name: "Edit contents of src/example.ts",
    });
    fireEvent.change(editor, {
      target: { value: "export const value = 2;\n" },
    });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      "src/example.ts",
      "export const value = 2;\n",
      "a".repeat(64),
    ));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the editor open and presents a conflict safely", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async () => {
      throw new Error(
        "This file changed after it was opened. Reload it before saving.",
      );
    });
    render(
      <FileEditorDialog file={file} onClose={onClose} onSave={onSave} />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "external conflict\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file changed after it was opened",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("preserves a CRLF file's newline convention after browser editing", async () => {
    const onSave = vi.fn(async (
      path: string,
      content: string,
      expectedDigest: string,
    ) => ({
      ...file,
      path,
      content,
      contentDigest: expectedDigest,
    }));
    render(
      <FileEditorDialog
        file={{
          ...file,
          content: "first\r\nsecond\r\n",
        }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const editor = screen.getByRole("textbox");
    expect(editor).toHaveValue("first\nsecond\n");
    fireEvent.change(editor, {
      target: { value: "first changed\nsecond\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      "src/example.ts",
      "first changed\r\nsecond\r\n",
      "a".repeat(64),
    ));
  });
});
