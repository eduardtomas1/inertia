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

  it("focuses and closes the provider-hosted browser flow for GitLab", async () => {
    const onClose = vi.fn();
    render(<PullRequestDialog
      open
      initialTitle="Ship the roadmap"
      busy={false}
      forge="gitlab"
      projectId={crypto.randomUUID()}
      run={vi.fn()}
      onClose={onClose}
    />);

    const dialog = screen.getByRole("dialog", {
      name: "Open GitLab merge request",
    });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Title" }))
      .not.toBeInTheDocument();
    const open = screen.getByRole("button", { name: "Open in GitLab" });
    await waitFor(() => expect(open).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps a nested repository identity in the provider-hosted browser flow", async () => {
    const url = "https://gitlab.com/example/project/-/merge_requests/new";
    const openExternal = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openExternal },
    });
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const run = vi.fn(async () => ({
      type: "request.result" as const,
      requestId: crypto.randomUUID(),
      result: { kind: "external.url" as const, url, label: "Open merge request" },
    }));
    render(<PullRequestDialog
      open
      initialTitle="Nested change"
      busy={false}
      forge="gitlab"
      projectId={projectId}
      conversationId={conversationId}
      repositoryPath="modules/alpha"
      authorityRef="33333333-3333-4333-8333-333333333333"
      run={run}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Open in GitLab" }));

    await waitFor(() => expect(run).toHaveBeenCalledWith("git.pr.open", {
      type: "git.pr.open",
      payload: {
        projectId,
        conversationId,
        repositoryPath: "modules/alpha",
        authorityRef: "33333333-3333-4333-8333-333333333333",
      },
    }));
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it("keeps the status-issued root identity in the create flow", async () => {
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const authorityRef = "33333333-3333-4333-8333-333333333333";
    const run = vi.fn(async () => new Promise<never>(() => undefined));
    render(<PullRequestDialog
      open
      initialTitle="Root change"
      busy={false}
      projectId={projectId}
      conversationId={conversationId}
      repositoryPath="."
      authorityRef={authorityRef}
      run={run}
      onClose={vi.fn()}
    />);

    await waitFor(() => expect(
      screen.getByRole("textbox", { name: "Title" }),
    ).toHaveFocus());
    fireEvent.click(screen.getByRole("button", {
      name: "Create pull request",
    }));

    expect(run).toHaveBeenCalledWith("git.pr.create", {
      type: "git.pr.create",
      payload: {
        projectId,
        conversationId,
        repositoryPath: ".",
        authorityRef,
        title: "Root change",
        body: "",
        draft: true,
      },
    });
  });

  it("preserves an edited title across background title refreshes", async () => {
    const props = {
      open: true,
      busy: false,
      projectId: crypto.randomUUID(),
      run: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(
      <PullRequestDialog initialTitle="Initial chat title" {...props} />,
    );
    const title = screen.getByRole("textbox", { name: "Title" });
    await waitFor(() => expect(title).toHaveFocus());
    fireEvent.change(title, { target: { value: "Deliberate PR title" } });

    view.rerender(
      <PullRequestDialog initialTitle="Background chat rename" {...props} />,
    );

    expect(title).toHaveValue("Deliberate PR title");
    expect(title).toHaveFocus();
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
