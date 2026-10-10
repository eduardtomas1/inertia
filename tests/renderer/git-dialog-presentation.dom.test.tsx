import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GitStatusSnapshot } from "@shared/contracts";
import { CommitDialog } from "../../src/renderer/src/components/CommitDialog";
import PullRequestDialog from "../../src/renderer/src/components/PullRequestDialog";
import { ReviewNoteDialog } from "../../src/renderer/src/components/ReviewNoteDialog";
import { readSourceText } from "../helpers/source-text";

const css = readSourceText("src/renderer/src/styles.css");

function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

const status = {
  branch: "main",
  insertions: 4,
  deletions: 1,
  files: [
    { path: "src/app.ts", staged: false, unstaged: true, untracked: false, insertions: 4, deletions: 1 },
    { path: "notes.md", staged: false, unstaged: false, untracked: true, insertions: 0, deletions: 0 },
  ],
} as unknown as GitStatusSnapshot;

describe("git dialog presentation", () => {
  it("lists commit paths as plain rows with quiet All and None controls", () => {
    render(<CommitDialog open repositoryPath="." status={status} diff={{ fingerprint: "empty", files: [] }}
      diffParsing={false} diffError={null} reviewStates={[]} busy={false} onClose={vi.fn()} onCommit={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Commit changes" });
    expect(screen.getByRole("button", { name: "All" })).toHaveClass("text-button");
    expect(screen.getByRole("button", { name: "None" })).toHaveClass("text-button");
    expect(dialog.querySelector(".commit-path-list strong, .commit-path-list small, header strong")).toBeNull();
    expect(screen.getByText("Untracked").tagName).toBe("SPAN");
    expect(dialog).not.toHaveTextContent("Only checked paths will be staged and committed.");
    expect(dialog).toHaveTextContent("Review marks never stage files.");
    expect(rule(".commit-path-list")).not.toMatch(/border:|border-radius/u);
    expect(rule(".commit-path-heading")).toMatch(/font-size: var\(--text-sm\)/u);
    expect(css).not.toMatch(/\.commit-path-heading button \{[^}]*--accent/u);
    expect(rule(".commit-path-list input")).toMatch(/accent-color: var\(--accent\)/u);
  });

  it("offers the draft option without a restating hint or a bold label", () => {
    render(<PullRequestDialog open initialTitle="Ship" busy={false} projectId="p" run={vi.fn()} onClose={vi.fn()} />);
    const draft = screen.getByRole("checkbox", { name: "Create as draft" });
    expect(draft.closest("label")?.querySelector("strong, small")).toBeNull();
    expect(screen.queryByText("Mark it ready on GitHub after review.")).toBeNull();
  });

  it("shows a review note save failure as danger text under the field", async () => {
    const save = vi.fn().mockRejectedValue(new Error("synthetic"));
    render(<ReviewNoteDialog draft={{ title: "Add review note", body: "", save }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), { target: { value: "Check" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toHaveClass("dialog-error");
    expect(readSourceText("src/renderer/src/components/DialogShell.css")).toMatch(/\.dialog-error \{[^}]*color: var\(--danger\)/u);
  });
});
