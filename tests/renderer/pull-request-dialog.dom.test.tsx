import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PullRequestDialog from "../../src/renderer/src/components/PullRequestDialog";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

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

  it("preserves a created pull request when opening the browser fails", async () => {
    const url = "https://github.com/openai/codex/pull/42";
    const openExternal = vi.fn(async () => {
      throw new Error("No browser is available");
    });
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText, openExternal },
    });
    const run = vi.fn(async () => ({
      type: "request.result" as const,
      requestId: crypto.randomUUID(),
      result: { kind: "external.url" as const, url, label: "GitHub pull request" },
    }));
    const onClose = vi.fn();
    render(<PullRequestDialog
      open
      initialTitle="Ship the roadmap"
      busy={false}
      projectId={crypto.randomUUID()}
      run={run}
      onClose={onClose}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The pull request was created",
    );
    expect(screen.getByRole("textbox", { name: "Created pull request link" }))
      .toHaveValue(url);
    expect(screen.queryByRole("button", { name: "Create pull request" }))
      .not.toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(url));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Pull request link copied.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try opening GitHub" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
