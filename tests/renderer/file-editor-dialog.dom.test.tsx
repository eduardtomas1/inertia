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
  it("colors escaped source only, retaining native text and IME composition", async () => {
    const content = 'public class Example { String text = "<img src=x onerror=alert(1)>"; }\n';
    const { container: _container } = render(<FileEditorDialog file={{ ...file, path: "Example.java", content }}
      canSave={() => true} onClose={vi.fn()} onSave={vi.fn()} />);
    const editor = screen.getByRole("textbox");
    await waitFor(() => expect(document.querySelector(".syntax-textarea-mirror .hljs-keyword")).not.toBeNull());
    expect(document.querySelector(".syntax-textarea-mirror")?.textContent).toBe(`${content}\n`);
    expect(document.querySelector(".syntax-textarea-mirror img")).toBeNull();
    expect(editor).toHaveValue(content);
    fireEvent.compositionStart(editor);
    expect(document.querySelector(".syntax-textarea")).not.toHaveClass("is-highlighted");
    fireEvent.change(editor, { target: { value: `${content}// é中文` } });
    expect(editor).toHaveValue(`${content}// é中文`);
    fireEvent.compositionEnd(editor);
    await waitFor(() => expect(document.querySelector(".syntax-textarea")).toHaveClass("is-highlighted"));
  });

  it("falls back to native plain text for oversized input without truncating the editable content", async () => {
    const content = `// ${"x".repeat(50_001)}`;
    render(<FileEditorDialog file={{ ...file, content }} canSave={() => true} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(await screen.findByText(/Plain text · highlighting unavailable/u)).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue(content);
    expect(document.querySelector(".syntax-textarea")).not.toHaveClass("is-highlighted");
  });
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
      <FileEditorDialog
        file={file}
        canSave={() => true}
        onClose={onClose}
        onSave={onSave}
      />,
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
      <FileEditorDialog
        file={file}
        canSave={() => true}
        onClose={onClose}
        onSave={onSave}
      />,
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
        canSave={() => true}
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

  it("blocks an edit when the exact serialized save command is too large", () => {
    const onSave = vi.fn();
    render(
      <FileEditorDialog
        file={file}
        canSave={(_path, content) => !content.includes("\"".repeat(20))}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "\"".repeat(20) },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "too large to send safely",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "s",
      ctrlKey: true,
    });
    expect(onSave).not.toHaveBeenCalled();
  });
});
