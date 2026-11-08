import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import {
  CheckoutBranchControlProvider,
  type CheckoutBranchControlModel,
} from "../../src/renderer/src/components/CheckoutBranchControl";
import { chatCheckoutBranch } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import type { Conversation, GitStatusSnapshot, Project } from "../../src/shared/contracts";
import { composerProps, conversation } from "./composer-fixtures";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Studio",
  path: "/work/studio",
  normalizedPath: "/work/studio",
  repositoryIdentity: "git:/work/studio/.git",
  repositoryRoot: "/work/studio",
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 16,
  color: "#5661d8",
  status: "ready",
  createdAt: "2026-07-29T08:00:00.000Z",
  updatedAt: "2026-07-29T08:00:00.000Z",
};

function knownStatus(branch: string | null): GitStatusSnapshot {
  return {
    isRepository: true,
    root: project.path,
    branch,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    files: [],
    insertions: 0,
    deletions: 0,
  };
}

function checkoutModel(gitStatus: GitStatusSnapshot | null): CheckoutBranchControlModel {
  return {
    project,
    conversation: null,
    gitStatus,
    branches: [],
    busy: false,
    onRefreshBranches: () => undefined,
    onSwitchBranch: () => undefined,
    onCreateBranch: () => undefined,
    onCreateConversationOnBranch: () => undefined,
    onCreateConversationInWorktree: () => undefined,
    onCreateConversationInIsolatedWorktree: () => undefined,
  };
}

function composerFor(current: Conversation, gitStatus: GitStatusSnapshot | null): React.JSX.Element {
  return (
    <CheckoutBranchControlProvider value={checkoutModel(gitStatus)}>
      <Composer {...composerProps(current, { checkoutBranch: chatCheckoutBranch(gitStatus) })} />
    </CheckoutBranchControlProvider>
  );
}

beforeAll(async () => {
  await import("../../src/renderer/src/components/CheckoutBranchMenuButton");
});

describe("composer checkout branch while Git status loads", () => {
  it("shows no detached checkout until the status is known, then offers to create a branch", async () => {
    const current: Conversation = { ...conversation("unbranched-chat"), branch: null, worktreePath: null };
    const view = render(composerFor(current, null));
    const strip = await screen.findByRole("group", { name: "Chat checkout context" });
    expect(strip).toHaveClass("is-branch-only");
    expect(strip).not.toHaveTextContent("Detached HEAD");
    expect(within(strip).queryByRole("button")).toBeNull();

    view.rerender(composerFor(current, knownStatus(null)));
    const trigger = await screen.findByRole("button", { name: "Detached HEAD, create or check out a branch" });
    expect(trigger.closest("[aria-label='Chat checkout context']")).not.toBeNull();
    expect(trigger).toHaveTextContent("Detached HEAD · Create branch");

    view.rerender(composerFor(current, null));
    await waitFor(() => {
      expect(screen.getByRole("group", { name: "Chat checkout context" })).not.toHaveTextContent("Detached HEAD");
    });
    expect(screen.queryByRole("button", { name: "Detached HEAD, create or check out a branch" })).toBeNull();
  });

  it("shows the stored branch while the status is unknown and the live branch once it arrives", async () => {
    const current: Conversation = { ...conversation("branched-chat"), branch: "feature/stored", worktreePath: null };
    const view = render(composerFor(current, null));
    const strip = await screen.findByRole("group", { name: "Chat checkout context" });
    expect(strip).toHaveTextContent("feature/stored");
    expect(strip).not.toHaveTextContent("Detached HEAD");

    view.rerender(composerFor(current, knownStatus("master")));
    const trigger = await screen.findByRole("button", { name: "Branch master" });
    expect(trigger.closest("[aria-label='Chat checkout context']")).not.toBeNull();
    expect(trigger).toHaveTextContent("master");
  });
});
