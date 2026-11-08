import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GitStatusSnapshot } from "@shared/contracts";
import { CommitDialog } from "../../src/renderer/src/components/CommitDialog";

const status = {
  branch: "main",
  insertions: 6,
  deletions: 1,
  files: [
    { path: "src/app/main.ts", status: "modified", staged: false, unstaged: true, untracked: false, insertions: 4, deletions: 1 },
    { path: "src/app/new.ts", status: "untracked", staged: false, unstaged: true, untracked: true, insertions: 2, deletions: 0 },
  ],
} as unknown as GitStatusSnapshot;

function renderDialog(options: { reviewSummary?: { overall: string; fingerprint: string } | null; busy?: boolean } = {}) {
  const onCommit = vi.fn(async () => undefined);
  render(<CommitDialog open repositoryPath="." status={status} diff={{ fingerprint: "empty", files: [] }}
    diffParsing={false} diffError={null} reviewStates={[]} busy={options.busy ?? false}
    reviewSummary={options.reviewSummary ?? null} onClose={vi.fn()} onCommit={onCommit} />);
  return { onCommit, message: screen.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement };
}

describe("commit dialog message authoring", () => {
  it("uses a labelled multi-line field that receives focus and keeps the 10,000-character bound", async () => {
    const { message } = renderDialog();

    expect(message.tagName).toBe("TEXTAREA");
    expect(message).toHaveAttribute("maxLength", "10000");
    await waitFor(() => expect(message).toHaveFocus());
    expect(message).toHaveAccessibleDescription(/Subject 0\/72.*commits\./u);
  });

  it("commits the full multi-line message with Cmd+Enter or Ctrl+Enter", async () => {
    const { message, onCommit } = renderDialog();
    fireEvent.change(message, { target: { value: "Fix startup\n\nExplain why.\n" } });

    fireEvent.keyDown(message, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(message, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(
      "Fix startup\n\nExplain why.",
      false,
      ["src/app/main.ts", "src/app/new.ts"],
    ));
  });

  it("shows the subject length against the 72-character soft limit without enforcing it", async () => {
    const { message, onCommit } = renderDialog();
    const subject = "x".repeat(80);
    fireEvent.change(message, { target: { value: `${subject}\n\nbody` } });

    expect(screen.getByText(/Subject 80\/72/u)).toHaveClass("is-over");
    expect(message).toHaveAccessibleDescription(/longer than recommended/u);
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(`${subject}\n\nbody`, false, expect.any(Array)));
  });

  it("drafts from selected files, then requires an explicit replace once text exists", () => {
    const { message } = renderDialog();
    const draft = screen.getByRole("button", { name: "Draft message" });

    fireEvent.click(draft);
    expect(message.value).toBe([
      "Update src/app",
      "",
      "- Modified: src/app/main.ts",
      "- Added: src/app/new.ts",
    ].join("\n"));
    expect(message).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Draft message" })).toBeNull();

    fireEvent.change(message, { target: { value: "My own words" } });
    expect(message.value).toBe("My own words");
    fireEvent.click(screen.getByRole("checkbox", { name: /src\/app\/new\.ts/u }));
    expect(message.value).toBe("My own words");

    fireEvent.click(screen.getByRole("button", { name: "Replace with draft" }));
    expect(message.value).toBe("Update src/app/main.ts\n\n- Modified: src/app/main.ts");
  });

  it("prefers the chat review summary and disables drafting without evidence or while busy", () => {
    const { message } = renderDialog({
      reviewSummary: { overall: "Adds a retry around startup. The loader now waits for the socket.", fingerprint: "empty" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Draft message" }));
    expect(message.value).toBe("Adds a retry around startup\n\nThe loader now waits for the socket.");

    fireEvent.click(screen.getByRole("button", { name: "None" }));
    fireEvent.change(message, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Draft message" })).toBeEnabled();
  });

  it("ignores a review summary written for a different change set", () => {
    const { message } = renderDialog({
      reviewSummary: { overall: "Adds a retry around startup.", fingerprint: "an-earlier-diff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Draft message" }));
    expect(message.value).toBe([
      "Update src/app",
      "",
      "- Modified: src/app/main.ts",
      "- Added: src/app/new.ts",
    ].join("\n"));
  });

  it("keeps the text a draft replaced restorable until the message is edited", () => {
    const { message } = renderDialog();
    fireEvent.change(message, { target: { value: "My own words" } });
    expect(screen.queryByRole("button", { name: "Restore your text" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replace with draft" }));
    expect(message.value).toMatch(/^Update src\/app/u);
    expect(screen.getByRole("status")).toHaveTextContent("The draft replaced your text.");
    fireEvent.click(screen.getByRole("button", { name: "Restore your text" }));
    expect(message.value).toBe("My own words");
    expect(message).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Restore your text" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replace with draft" }));
    fireEvent.change(message, { target: { value: `${message.value} and more` } });
    expect(screen.queryByRole("button", { name: "Restore your text" })).toBeNull();
  });

  it("disables the draft button when no summary or path is selected", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByRole("button", { name: "Draft message" })).toBeDisabled();
  });

  it("locks the draft button while a commit is in flight", () => {
    renderDialog({ busy: true });
    expect(screen.getByRole("button", { name: "Draft message" })).toBeDisabled();
  });
});
