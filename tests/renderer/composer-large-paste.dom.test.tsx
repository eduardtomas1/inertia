import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import { composerProps, conversation } from "./composer-fixtures";
function attachment(id: string): ChatAttachment {
  return { id, path: id, name: `${id}.txt`, mimeType: "text/plain", size: 1 };
}
function attachmentLease(attachments: ChatAttachment[]) {
  return { attachments, commit: async () => undefined, cancel: async () => undefined };
}
afterEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
describe("large pasted text", () => {
  it("folds a large UTF-8 paste into an attachment without replacing the draft", async () => {
    const text = "界".repeat(11_000);
    const selected = { ...attachment("pasted"), name: "pasted.txt", mimeType: "text/plain" as const, size: new TextEncoder().encode(text).length };
    const onImportAttachments = vi.fn(async () => attachmentLease([selected]));
    render(<Composer {...composerProps(conversation("large-paste"), { onImportAttachments })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Keep these instructions" } });
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => text } });
    await waitFor(() => expect(onImportAttachments).toHaveBeenCalledOnce());
    const files = (onImportAttachments.mock.calls as unknown as Array<[File[]]>)[0]![0];
    expect(await files[0]!.text()).toBe(text);
    expect(files[0]!.type).toBe("text/plain");
    expect(input).toHaveValue("Keep these instructions");
    await screen.findByText("pasted.txt");
  });

  it("leaves shift-paste inline and restores text when attachment import fails", async () => {
    const text = "x".repeat(33_000);
    const onImportAttachments = vi.fn(async () => null);
    render(<Composer {...composerProps(conversation("failed-paste"), { onImportAttachments })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(input, { key: "V", shiftKey: true, ctrlKey: true });
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => text } });
    expect(onImportAttachments).not.toHaveBeenCalled();
    fireEvent.keyUp(input, { key: "V" });
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => text } });
    await waitFor(() => expect(input).toHaveValue(text));
  });


  it.each([false, true])("uses the UTF-8 byte boundary exactly: at threshold %s", (atThreshold) => {
    const onImportAttachments = vi.fn(async () => null);
    render(<Composer {...composerProps(conversation("paste-boundary"), { onImportAttachments })} />);
    const text = "界".repeat(10_922) + (atThreshold ? "aa" : "");
    fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), { clipboardData: { files: [], getData: () => text } });
    expect(onImportAttachments).toHaveBeenCalledTimes(atThreshold ? 1 : 0);
  });
});
