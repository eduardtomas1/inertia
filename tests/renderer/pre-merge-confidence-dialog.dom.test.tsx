import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PreMergeConfidenceDialog from "../../src/renderer/src/components/PreMergeConfidenceDialog";
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

  it("keeps an unresolved Codex thread and skipped platform unmistakably blocking", async () => {
    const thread = {
      id: "thread-1",
      path: "src/server/git/github-pre-merge.ts",
      line: 91,
      author: "chatgpt-codex-connector",
      body: "Revalidate the GitHub head after loading review threads.",
      url: "https://github.com/openai/codex/pull/42#discussion_r1",
      codex: true,
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
    expect(within(dialog).getAllByText("Skipped").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Missing").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("1 actionable review thread remains."))
      .toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open thread" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(thread.url));
  });
});
