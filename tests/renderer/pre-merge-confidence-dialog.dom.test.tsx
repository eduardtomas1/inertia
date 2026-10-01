import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PreMergeConfidenceDialog from "../../src/renderer/src/components/PreMergeConfidenceDialog";
import { PrFeedbackSection } from "../../src/renderer/src/components/PrFeedbackSection";
import { COMPOSER_PREFILL_EVENT } from "../../src/renderer/src/utils/composerPrefill";
import type { GitPreMergeConfidence, ServerEvent } from "../../src/shared/contracts";

function confidence(
  overrides: Partial<GitPreMergeConfidence> = {},
): GitPreMergeConfidence {
  const head = "a".repeat(40);
  return {
    generatedAt: new Date().toISOString(),
    state: "ready",
    unavailableReason: null,
    local: {
      branch: "codex/confidence",
      head,
      dirty: false,
      files: [],
      filesTruncated: false,
    },
    github: {
      repository: "openai/codex",
      number: 42,
      url: "https://github.com/openai/codex/pull/42",
      title: "Build pre-merge confidence",
      state: "OPEN",
      draft: false,
      headBranch: "codex/confidence",
      head,
      baseBranch: "main",
      mergeState: "CLEAN",
      reviewDecision: "APPROVED",
      updatedAt: new Date().toISOString(),
    },
    identity: {
      state: "exact",
      detail: "Local aaaaaaaa exactly matches GitHub PR #42.",
    },
    checks: [
      { name: "Linux x64", workflow: "CI", state: "passed", detailsUrl: null, startedAt: null, completedAt: null },
      { name: "Windows x64", workflow: "CI", state: "passed", detailsUrl: null, startedAt: null, completedAt: null },
      { name: "macOS arm64", workflow: "CI", state: "passed", detailsUrl: null, startedAt: null, completedAt: null },
    ],
    checksTruncated: false,
    platforms: [
      { platform: "Linux", state: "passed", checks: ["Linux x64"] },
      { platform: "Windows", state: "passed", checks: ["Windows x64"] },
      { platform: "macOS", state: "passed", checks: ["macOS arm64"] },
    ],
    reviewThreads: [],
    reviewThreadsTruncated: false,
    files: [
      { path: "src/server/git/github-pre-merge.ts", area: "Local runtime", insertions: 80, deletions: 2 },
      { path: "tests/server/github-pre-merge.test.ts", area: "Tests", insertions: 45, deletions: 0 },
    ],
    totalFiles: 2,
    filesTruncated: false,
    areas: [
      { name: "Local runtime", files: 1 },
      { name: "Tests", files: 1 },
    ],
    changedTestFiles: ["tests/server/github-pre-merge.test.ts"],
    focusedTestChecks: ["Renderer DOM tests"],
    bundle: {
      state: "not-published",
      summary: "No authoritative bundle delta was published for this exact head.",
    },
    authorClaim: {
      source: "pull-request-body",
      body: "## Verification\n\n- npm run check",
      truncated: false,
    },
    mergeReadiness: { state: "ready", blockers: [] },
    releaseReadiness: {
      state: "not-proven",
      detail: "Release evidence requires the exact tag workflow.",
    },
    ...overrides,
  };
}

function result(value: GitPreMergeConfidence): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: { kind: "git.pr.confidence", confidence: value },
  };
}

describe("PR feedback drafts", () => {
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const feedback = (): GitPreMergeConfidence => confidence({ reviewThreads: [{
    id: "review-1", path: "src/retry.ts", line: 42, author: "reviewer", codex: false,
    body: "Handle failures.", outdated: false, url: "https://github.com/openai/codex/pull/42#discussion_r1",
    discussion: { truncated: false, comments: [{ author: "reviewer", body: "Handle failures and preserve the retry count.", url: null }] },
  }] });
  const props = { projectId: "11111111-1111-4111-8111-111111111111", conversationId, repositoryPath: ".", authorityRef: "33333333-3333-4333-8333-333333333333", disabled: false, onOpenUrl: vi.fn() };

  it("reloads selected discussions and sends a scoped prefill only after successful verification", async () => {
    const prefill = vi.fn();
    window.addEventListener(COMPOSER_PREFILL_EVENT, prefill);
    try {
      const run = vi.fn(async () => result(feedback()));
      const onClose = vi.fn();
      render(<PrFeedbackSection {...props} confidence={feedback()} run={run} onClose={onClose} />);
      expect(screen.getByRole("button", { name: "Address selected feedback" })).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all review feedback" }));
      fireEvent.click(screen.getByRole("button", { name: "Address selected feedback" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(run).toHaveBeenCalledWith("git.pr.feedback", { type: "git.pr.confidence", payload: { projectId: props.projectId, conversationId, repositoryPath: ".", authorityRef: props.authorityRef, reviewThreadIds: ["review-1"] } });
      expect((prefill.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ conversationId, text: expect.stringContaining("preserve the retry count") });
      expect(prefill).toHaveBeenCalledOnce();
    } finally { window.removeEventListener(COMPOSER_PREFILL_EVENT, prefill); }
  });

  it("keeps the dialog open without changing a draft when feedback changes", async () => {
    const onClose = vi.fn();
    render(<PrFeedbackSection {...props} confidence={feedback()} run={vi.fn(async () => result({ ...feedback(), reviewThreads: [] }))} onClose={onClose} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all review feedback" }));
    fireEvent.click(screen.getByRole("button", { name: "Address selected feedback" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("discussion changed");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves composer focus when prefill runs before dialog cleanup, while normal dismissal restores its trigger", async () => {
    const trigger = document.createElement("button");
    const composer = document.createElement("textarea");
    document.body.append(trigger, composer);
    trigger.focus();
    // Reproduce the animation frame completing before React's passive cleanup.
    const focusDraft = (): void => composer.focus();
    window.addEventListener(COMPOSER_PREFILL_EVENT, focusDraft);
    const run = vi.fn(async () => result(feedback()));
    const onClose = vi.fn();
    const dialogProps = { ...props, run, onClose };
    const view = render(<PreMergeConfidenceDialog {...dialogProps} open />);
    try {
      await waitFor(() => expect(screen.getByRole("button", { name: "Close pre-merge confidence" })).toHaveFocus());
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all review feedback" }));
      fireEvent.click(screen.getByRole("button", { name: "Address selected feedback" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      view.rerender(<PreMergeConfidenceDialog {...dialogProps} open={false} />);
      expect(composer).toHaveFocus();

      trigger.focus();
      view.rerender(<PreMergeConfidenceDialog {...dialogProps} open />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Close pre-merge confidence" })).toHaveFocus());
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      view.rerender(<PreMergeConfidenceDialog {...dialogProps} open={false} />);
      expect(trigger).toHaveFocus();
    } finally {
      view.unmount();
      window.removeEventListener(COMPOSER_PREFILL_EVENT, focusDraft);
      trigger.remove(); composer.remove();
    }
  });

  it("keeps the action focused and prevents duplicate requests while loading", async () => {
    let fail!: (reason: Error) => void;
    const run = vi.fn(() => new Promise<ServerEvent>((_resolve, reject) => { fail = reject; }));
    render(<PrFeedbackSection {...props} confidence={feedback()} run={run} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all review feedback" }));
    const action = screen.getByRole("button", { name: "Address selected feedback" });
    action.focus();
    fireEvent.click(action);
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(action).toHaveFocus();
    fireEvent.click(action);
    expect(run).toHaveBeenCalledOnce();
    await act(async () => fail(new Error("Connection lost")));
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
    expect(action).toHaveFocus();
    expect(action).not.toHaveAttribute("aria-disabled");
  });

  it("ignores a late response after the selected chat changes", async () => {
    let settle!: (event: ServerEvent) => void;
    const run = vi.fn(() => new Promise<ServerEvent>((resolve) => { settle = resolve; }));
    const prefill = vi.fn();
    const onClose = vi.fn();
    const value = feedback();
    window.addEventListener(COMPOSER_PREFILL_EVENT, prefill);
    try {
      const view = render(<PrFeedbackSection {...props} confidence={value} run={run} onClose={onClose} />);
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all review feedback" }));
      fireEvent.click(screen.getByRole("button", { name: "Address selected feedback" }));
      view.rerender(<PrFeedbackSection {...props} conversationId="another-chat" confidence={value} run={run} onClose={onClose} />);
      await act(async () => settle(result(value)));
      expect(prefill).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally { window.removeEventListener(COMPOSER_PREFILL_EVENT, prefill); }
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("PreMergeConfidenceDialog", () => {
  it("shows exact-head GitHub evidence without promoting claims or missing bundle proof", async () => {
    const value = confidence();
    const run = vi.fn(async () => result(value));
    const onClose = vi.fn();
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openExternal: vi.fn(async () => undefined) },
    });
    render(<PreMergeConfidenceDialog
      open
      projectId="11111111-1111-4111-8111-111111111111"
      conversationId="22222222-2222-4222-8222-222222222222"
      repositoryPath="."
      authorityRef="33333333-3333-4333-8333-333333333333"
      run={run}
      onClose={onClose}
    />);

    const dialog = await screen.findByRole("dialog", {
      name: "Exact-head green",
    });
    expect(within(dialog).getAllByText("GitHub authoritative").length)
      .toBeGreaterThan(0);
    expect(within(dialog).getAllByText("GitHub").length).toBeGreaterThan(2);
    expect(within(dialog).getByText("No unresolved, current review threads."))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/No authoritative bundle delta/iu))
      .toBeInTheDocument();
    expect(within(dialog).getByText("Not proven"))
      .toBeInTheDocument();
    expect(within(dialog).getByText("PR author claim"))
      .toBeInTheDocument();
    expect(within(dialog).getByText(
      "Changed test files are scope evidence, not proof that they ran.",
    )).toBeInTheDocument();
    expect(run).toHaveBeenCalledWith("git.pr.confidence", {
      type: "git.pr.confidence",
      payload: {
        projectId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
        repositoryPath: ".",
        authorityRef: "33333333-3333-4333-8333-333333333333",
      },
    });

    const close = within(dialog).getByRole("button", {
      name: "Close pre-merge confidence",
    });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("withholds green when evidence is stale even if its prior verdict was ready", async () => {
    render(<PreMergeConfidenceDialog
      open
      projectId="11111111-1111-4111-8111-111111111111"
      repositoryPath="."
      authorityRef="33333333-3333-4333-8333-333333333333"
      run={vi.fn(async () => result(confidence({
        generatedAt: "2020-01-01T00:00:00.000Z",
      })))}
      onClose={vi.fn()}
    />);

    expect(await screen.findByRole("heading", { name: "Refresh required" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Exact-head green" }))
      .not.toBeInTheDocument();
    expect(screen.getByText(/older than one minute/iu)).toBeInTheDocument();
  });

  it("invalidates a prior green result when exact-head refresh fails", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result(confidence()))
      .mockRejectedValueOnce(new Error("GitHub revalidation failed."));
    render(<PreMergeConfidenceDialog
      open
      projectId="11111111-1111-4111-8111-111111111111"
      repositoryPath="."
      authorityRef="33333333-3333-4333-8333-333333333333"
      run={run}
      onClose={vi.fn()}
    />);

    const initial = await screen.findByRole("dialog", { name: "Exact-head green" });
    fireEvent.click(within(initial).getByRole("button", {
      name: "Refresh pre-merge evidence",
    }));

    expect(await screen.findByRole("heading", { name: "Evidence unavailable" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Exact-head green" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub revalidation failed.");
  });

  it("keeps keyboard focus inside the dialog while a focused refresh is running", async () => {
    let finishRefresh!: (event: ServerEvent) => void;
    const run = vi.fn()
      .mockResolvedValueOnce(result(confidence()))
      .mockImplementationOnce(() => new Promise<ServerEvent>((resolve) => {
        finishRefresh = resolve;
      }));
    const onClose = vi.fn();
    render(<PreMergeConfidenceDialog
      open
      projectId="11111111-1111-4111-8111-111111111111"
      repositoryPath="."
      authorityRef="33333333-3333-4333-8333-333333333333"
      run={run}
      onClose={onClose}
    />);
    const dialog = await screen.findByRole("dialog", { name: "Exact-head green" });
    const refresh = within(dialog).getByRole("button", {
      name: "Refresh pre-merge evidence",
    });
    refresh.focus();

    fireEvent.click(refresh);

    expect(refresh).toBeDisabled();
    const close = within(dialog).getByRole("button", { name: "Close pre-merge confidence" });
    expect(close).toHaveFocus();

    await act(async () => { finishRefresh(result(confidence())); });
    await waitFor(() => expect(refresh).toHaveFocus());

    refresh.focus();
    fireEvent.click(refresh);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps an unresolved Codex thread and skipped platform unmistakably blocking", async () => {
    const thread = {
      id: "thread-1",
      path: "src/server/git/github-pre-merge.ts",
      line: 91,
      author: "chatgpt-codex-connector",
      body: "Revalidate the GitHub head after loading review threads.",
      url: "https://github.com/openai/codex/pull/42#discussion_r1",
      codex: true,
      outdated: true,
    } as const;
    const openExternal = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openExternal },
    });
    render(<PreMergeConfidenceDialog
      open
      projectId="11111111-1111-4111-8111-111111111111"
      repositoryPath="."
      authorityRef="33333333-3333-4333-8333-333333333333"
      run={vi.fn(async () => result(confidence({
        platforms: [
          { platform: "Linux", state: "passed", checks: ["Linux x64"] },
          { platform: "Windows", state: "skipped", checks: ["Windows x64"] },
          { platform: "macOS", state: "missing", checks: [] },
        ],
        reviewThreads: [thread],
        mergeReadiness: {
          state: "blocked",
          blockers: [
            "Windows coverage is skipped.",
            "macOS coverage is missing.",
            "1 actionable review thread remains.",
          ],
        },
      })))}
      onClose={vi.fn()}
    />);

    const dialog = await screen.findByRole("dialog", { name: "Needs attention" });
    expect(within(dialog).getByText("1 Codex · 0 other unresolved"))
      .toBeInTheDocument();
    expect(within(dialog).getByText(thread.body)).toBeInTheDocument();
    expect(within(dialog).getByText("Outdated position")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Skipped").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Missing").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("1 actionable review thread remains."))
      .toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open thread" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(thread.url));
  });
});
