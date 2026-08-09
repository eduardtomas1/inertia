import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PullRequestDialog from "../../src/renderer/src/components/PullRequestDialog";

describe("PullRequestDialog", () => {
  it("traps keyboard focus and closes on Escape when idle", () => {
    const onClose = vi.fn();
    render(<PullRequestDialog
      open
      initialTitle="Ship the roadmap"
      busy={false}
      projectId={crypto.randomUUID()}
      run={vi.fn()}
      onClose={onClose}
    />);
    const dialog = screen.getByRole("dialog", {
      name: "Create GitHub pull request",
    });
    const close = screen.getByRole("button", {
      name: "Close pull request dialog",
    });
    const create = screen.getByRole("button", {
      name: "Create pull request",
    });

    create.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(create).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the provider-hosted browser flow for GitLab", () => {
    render(<PullRequestDialog
      open
      initialTitle="Ship the roadmap"
      busy={false}
      forge="gitlab"
      projectId={crypto.randomUUID()}
      run={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("dialog", {
      name: "Open GitLab merge request",
    })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Title" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in GitLab" }))
      .toBeInTheDocument();
  });
});
