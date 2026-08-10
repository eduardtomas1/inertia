// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type JSX } from "react";
import { describe, expect, it, vi } from "vitest";

import { RootCommitDialog } from "../../src/renderer/src/components/CommitDialog";
import type { ChangedFile, GitDiffSnapshot, GitStatusSnapshot } from "../../src/shared/contracts";

function file(path: string): ChangedFile {
  return {
    path,
    status: "modified",
    insertions: 2,
    deletions: 1,
    untracked: false,
    staged: false,
    unstaged: true,
    indexStatus: " ",
    worktreeStatus: "M",
  };
}

const status: GitStatusSnapshot = {
  isRepository: true,
  authorityRef: "11111111-1111-4111-8111-111111111111",
  root: "/workspace/inertia",
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  hasRemote: false,
  files: [file("ambient.ts")],
  insertions: 90,
  deletions: 40,
};

function review(path = "exact.ts"): GitDiffSnapshot {
  return {
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n"),
    truncated: false,
    files: [file(path)],
    commitReview: {
      authorityRef: "22222222-2222-4222-8222-222222222222",
      fingerprint: "a".repeat(64),
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RootCommitDialog", () => {
  it("shows an accessible preparing state and derives paths and counts from the exact review", async () => {
    const pending = deferred<GitDiffSnapshot | null>();
    render(
      <RootCommitDialog
        owner="project:conversation"
        revision={0}
        status={status}
        reviewStates={[]}
        busy={false}
        loadReview={() => pending.promise}
        discardReview={vi.fn()}
        onClose={vi.fn()}
        onError={vi.fn()}
        onCommit={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing the complete diff",
    );
    expect(screen.getByText(/0 files/iu)).toHaveTextContent("+0");
    expect(screen.queryByText("ambient.ts")).not.toBeInTheDocument();

    await act(async () => pending.resolve(review()));

    expect(await screen.findByText("exact.ts")).toBeInTheDocument();
    expect(screen.queryByText("ambient.ts")).not.toBeInTheDocument();
    expect(screen.getByText(/1 files/iu)).toHaveTextContent("+2");
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveFocus();
  });

  it("closes and retires the review when Git is invalidated", async () => {
    const discardReview = vi.fn();
    const onClose = vi.fn();
    const props = {
      owner: "project:conversation",
      revision: 0,
      status,
      reviewStates: [],
      busy: false,
      loadReview: vi.fn(async () => review()),
      discardReview,
      onClose,
      onError: vi.fn(),
      onCommit: vi.fn(async () => undefined),
    };
    const view = render(<RootCommitDialog {...props} />);
    expect(await screen.findByText("exact.ts")).toBeInTheDocument();

    view.rerender(<RootCommitDialog {...props} revision={1} />);

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(discardReview).toHaveBeenCalled();
  });

  it("suppresses a delayed rejection after the owner changes", async () => {
    const pending = deferred<GitDiffSnapshot | null>();
    const onClose = vi.fn();
    const onError = vi.fn();
    const props = {
      owner: "alpha:chat",
      revision: 0,
      status,
      reviewStates: [],
      busy: false,
      loadReview: vi.fn(() => pending.promise),
      discardReview: vi.fn(),
      onClose,
      onError,
      onCommit: vi.fn(async () => undefined),
    };
    const view = render(<RootCommitDialog {...props} />);

    view.rerender(<RootCommitDialog {...props} owner="beta:chat" />);
    await act(async () => pending.reject(new Error("stale alpha failure")));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
  });

  it("closes after a failed submit so a consumed receipt cannot be retried", async () => {
    const onCommit = vi.fn(async () => {
      throw new Error("commit failed");
    });
    function Harness(): JSX.Element | null {
      const [open, setOpen] = useState(true);
      return open ? (
        <RootCommitDialog
          owner="project:conversation"
          revision={0}
          status={status}
          reviewStates={[]}
          busy={false}
          loadReview={async () => review()}
          discardReview={vi.fn()}
          onClose={() => setOpen(false)}
          onError={vi.fn()}
          onCommit={onCommit}
        />
      ) : null;
    }
    render(<Harness />);
    const message = await screen.findByRole("textbox", {
      name: "Commit message",
    });
    fireEvent.change(message, { target: { value: "Reviewed commit" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Commit changes",
    })).not.toBeInTheDocument());
    expect(onCommit).toHaveBeenCalledOnce();
  });
});
