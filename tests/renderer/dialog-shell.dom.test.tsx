import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DialogHeader, DialogShell } from "../../src/renderer/src/components/DialogShell";
import { readSourceText } from "../helpers/source-text";

describe("dialog shell", () => {
  it("names the modal by its one title row and closes from its one close button", () => {
    const close = vi.fn();
    render(
      <DialogShell titleId="shell-title" title="Commit changes" description="main · 2 files" descriptionId="shell-description"
        closeLabel="Close commit dialog" onClose={close}
        footer={<><button type="button" className="secondary-button">Commit</button><button type="button" className="primary-button">Commit & push</button></>}>
        <p>Body</p>
      </DialogShell>,
    );
    const dialog = screen.getByRole("dialog", { name: "Commit changes" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("main · 2 files");
    expect(dialog).toHaveClass("dialog-shell");
    expect(dialog.parentElement).toHaveClass("dialog-backdrop");
    expect(dialog.querySelectorAll("h2")).toHaveLength(1);
    expect(dialog.querySelector(".dialog-shell-header")).toContainElement(screen.getByRole("button", { name: "Close commit dialog" }));
    expect(dialog.querySelectorAll(".dialog-shell-header button")).toHaveLength(1);
    expect([...dialog.querySelectorAll(".dialog-shell-footer button")].map((button) => button.textContent)).toEqual(["Commit", "Commit & push"]);
    fireEvent.click(screen.getByRole("button", { name: "Close commit dialog" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes with one Escape while the close button's tooltip is showing", async () => {
    const close = vi.fn();
    render(
      <DialogShell titleId="t" title="Restart" closeLabel="Close restart confirmation" onClose={close}
        onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
        <p>Body</p>
      </DialogShell>,
    );
    const button = screen.getByRole("button", { name: "Close restart confirmation" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    await waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
    fireEvent.keyDown(button, { key: "Escape" });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("wraps a long title instead of cutting off its end", () => {
    const rule = /\.dialog-shell-heading > h2 \{([^}]*)\}/u.exec(readSourceText("src/renderer/src/components/DialogShell.css"))?.[1] ?? "";
    expect(rule).toContain("overflow-wrap: anywhere;");
    expect(rule).not.toMatch(/text-overflow|white-space: nowrap/u);
  });

  it("stacks every dialog on one backdrop layer above the status toasts", () => {
    const sources = [
      "src/renderer/src/styles.css",
      "src/renderer/src/components/UsageLimitsPanel.css",
      "src/renderer/src/components/composer/SnapshotControl.css",
    ].map((path) => readSourceText(path)).join("\n");
    const backdrops = [...sources.matchAll(/(?<selector>[^{}\n]*backdrop[^{}\n]*)\{(?<body>[^}]*)\}/gu)]
      .filter(({ groups }) => /z-index/u.test(groups!.body!) && !/palette|welcome/u.test(groups!.selector!));
    expect(backdrops.map(({ groups }) => groups!.selector!.trim())).toEqual([".dialog-backdrop"]);
    expect(backdrops[0]!.groups!.body).toContain("z-index: 105;");
    expect(sources).toMatch(/\.workspace-frame > \.status-overlay-stack \{[^}]*z-index: 100;/u);
  });

  it("describes the dialog by its visible description even without a caller id", () => {
    render(<DialogShell titleId="pr-title" title="Create pull request" description="Uses your local GitHub CLI sign-in." closeLabel="Close" onClose={vi.fn()}><p>Body</p></DialogShell>);
    expect(screen.getByRole("dialog", { name: "Create pull request" })).toHaveAccessibleDescription("Uses your local GitHub CLI sign-in.");
  });

  it("dismisses from the backdrop only when the caller allows it", () => {
    const dismiss = vi.fn();
    render(<DialogShell titleId="t" title="Snapshots" closeLabel="Close Snapshots" onClose={vi.fn()} onDismiss={dismiss}><p>Body</p></DialogShell>);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("keeps Tab inside the dialog and leaves Escape to the caller", () => {
    const keyDown = vi.fn();
    render(
      <DialogShell titleId="t" title="Review note" closeLabel="Close review note" onClose={vi.fn()} onKeyDown={keyDown}
        footer={<button type="button" className="primary-button">Save note</button>}>
        <textarea aria-label="Review note" />
      </DialogShell>,
    );
    const close = screen.getByRole("button", { name: "Close review note" });
    const save = screen.getByRole("button", { name: "Save note" });
    const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
    fireEvent.keyDown(save, { key: "Escape" });
    expect(keyDown).toHaveBeenLastCalledWith(expect.objectContaining({ key: "Escape" }));
    rects.mockRestore();
  });

  it("submits a form surface from a footer button and keeps an explicit accessible name", () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <DialogShell titleId="t" title="Open local folder" aria-label="Add project" closeLabel="Close add project" onClose={vi.fn()}
        onSubmit={submit} footer={<button type="submit" className="primary-button">Open project</button>}>
        <input aria-label="Folder path" />
      </DialogShell>,
    );
    const dialog = screen.getByRole("dialog", { name: "Add project" });
    expect(dialog.tagName).toBe("FORM");
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("gives native dialogs the same header", () => {
    const close = vi.fn();
    render(<dialog open className="dialog-shell" aria-labelledby="h"><DialogHeader titleId="h" title="Restart to install Inertia 1.2.3?" closeLabel="Close restart confirmation" onClose={close} /></dialog>);
    fireEvent.click(screen.getByRole("button", { name: "Close restart confirmation" }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Restart to install Inertia 1.2.3?");
  });

  it("is the one surface every modal dialog in the app chrome renders", () => {
    for (const file of [
      "AddProjectDialog.tsx",
      "CliConversationImportDialog.tsx",
      "CommitDialog.tsx",
      "DailyWorkDialog.tsx",
      "DiagnosticsClearDialog.tsx",
      "DocumentAttachmentPreview.tsx",
      "FileEditorDialog.tsx",
      "MultiSpawnDialog.tsx",
      "PreMergeConfidenceDialog.tsx",
      "PullRequestDialog.tsx",
      "ReviewNoteDialog.tsx",
      "UsageLimitsPanel.tsx",
      "composer/ReviewedScreenshotControl.tsx",
      "composer/SnapshotControl.tsx",
      "response-timeline/html-render-dialog.tsx",
      "sidebar/UpdateRestartConfirmation.tsx",
    ]) {
      const source = readSourceText(`src/renderer/src/components/${file}`);
      expect(source, file).toMatch(/<Dialog(?:Shell|Header)\b/u);
      expect(source, file).not.toMatch(/aria-modal="true"|className="(?:dialog|snapshot|attachment-preview)-backdrop/u);
    }
  });

  it("keeps snapshot errors and the screenshot review flat", () => {
    const snapshot = readSourceText("src/renderer/src/components/composer/SnapshotControl.css");
    expect(snapshot).toMatch(/\.snapshot-alert \{ margin: 0; color: var\(--danger\); \}/u);
    expect(snapshot).not.toMatch(/\.snapshot-alert code \{[^}]*border:/u);
    const review = readSourceText("src/renderer/src/components/composer/ReviewedScreenshotControl.css");
    expect(review).toMatch(/\.screenshot-sources button:hover:not\(:disabled\) \{ background: var\(--fill\); \}/u);
    expect(review).not.toMatch(/\.screenshot-edit \{[^}]*border: 1px/u);
  });
});
