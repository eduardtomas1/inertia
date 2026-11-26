import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { createWorktreeWithOwnershipReceipt } from "../../src/server/git";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import {
  hasIncompleteWorktreeSetup,
  WorkspacePathAuthority,
  WorkspacePathAuthorityError,
  WorktreeSetupIncompleteError,
} from "../../src/server/workspace-path-authority";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

function createGitProject(root: string): string {
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "n9@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "N9 Test"], { cwd: workspace });
  writeFileSync(join(workspace, "README.md"), "n9 containment test\n");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  return realpathSync.native(workspace);
}

describe("N9 isolated worktree containment guard", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  it("fails closed instead of falling back to projectPath while worktree creation is incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-n9-containment-"));
    directories.push(root);
    const workspace = createGitProject(root);
    const dbPath = join(root, "inertia.sqlite");
    const store = new RuntimeStore(dbPath, workspace);
    try {
      const project = store.createProject(
        "N9 Project",
        workspace,
        await inspectProjectIdentity(workspace),
      );
      const conversation = store.createConversation(project.id, "Pending isolated chat");
      const plannedPath = join(root, "worktrees", "pending-chat");
      const token = randomUUID();
      store.conversationWorktrees.beginCreation(
        conversation.id,
        plannedPath,
        "inertia/pending-chat",
        token,
      );

      expect(() => store.conversationPath(conversation.id)).toThrow(WorktreeSetupIncompleteError);
      expect(() => store.conversationPath(conversation.id)).toThrow(WorkspacePathAuthorityError);
      expect(() => store.conversationPath(conversation.id)).toThrow(
        "Isolated worktree setup did not finish for this chat.",
      );

      const reader = new Database(dbPath, { readonly: true });
      try {
        const authority = new WorkspacePathAuthority(reader);
        expect(hasIncompleteWorktreeSetup(reader, conversation.id)).toBe(true);
        expect(authority.hasIncompleteWorktreeSetup(conversation.id)).toBe(true);
      } finally {
        reader.close();
      }

      // Rejecting creation cleans up the pending row, after which normal resolution is allowed again.
      store.conversationWorktrees.rejectCreation(conversation.id);
      const afterReject = new Database(dbPath, { readonly: true });
      try {
        expect(hasIncompleteWorktreeSetup(afterReject, conversation.id)).toBe(false);
      } finally {
        afterReject.close();
      }
      expect(store.conversationPath(conversation.id)).toBe(workspace);
    } finally {
      store.close();
    }
  });

  it("fails closed if owns_worktree = 1 while conversations.worktree_path is still NULL", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-n9-inconsistent-"));
    directories.push(root);
    const workspace = createGitProject(root);
    const dbPath = join(root, "inertia.sqlite");
    const store = new RuntimeStore(dbPath, workspace);
    try {
      const project = store.createProject(
        "N9 Project",
        workspace,
        await inspectProjectIdentity(workspace),
      );
      const conversation = store.createConversation(project.id, "Owned without path");
      const direct = new Database(dbPath);
      try {
        direct.prepare(`
          INSERT INTO conversation_worktree_ownership (
            conversation_id, path, branch, owns_worktree, creation_state,
            ownership_token, worktree_id, repository_identity,
            filesystem_identity_json, branch_head
          ) VALUES (?, ?, ?, 1, 'created', ?, ?, ?, ?, ?)
        `).run(
          conversation.id,
          join(root, "worktrees", "missing"),
          "inertia/missing",
          randomUUID(),
          "wt-1",
          "a".repeat(64),
          JSON.stringify({ device: "1", inode: "2", birthtimeNs: "3" }),
          "b".repeat(40),
        );
        expect(hasIncompleteWorktreeSetup(direct, conversation.id)).toBe(true);
      } finally {
        direct.close();
      }
      expect(() => store.conversationPath(conversation.id)).toThrow(WorktreeSetupIncompleteError);
    } finally {
      store.close();
    }
  });

  it("clears the incomplete flag and resolves the worktree path once creation completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-n9-complete-"));
    directories.push(root);
    const workspace = createGitProject(root);
    const dbPath = join(root, "inertia.sqlite");
    const store = new RuntimeStore(dbPath, workspace);
    try {
      const project = store.createProject(
        "N9 Project",
        workspace,
        await inspectProjectIdentity(workspace),
      );
      const conversation = store.createConversation(project.id, "Completed isolated chat");
      const plannedPath = join(root, "worktrees", "completed-chat");
      const branch = "inertia/completed-chat";
      await createWorktreeWithOwnershipReceipt(
        workspace,
        plannedPath,
        { branch, createBranch: true, startPoint: "HEAD" },
        {
          beforeAdd: (ownershipToken) => {
            store.conversationWorktrees.beginCreation(conversation.id, plannedPath, branch, ownershipToken);
          },
          notAdded: () => {
            store.conversationWorktrees.rejectCreation(conversation.id);
          },
          added: (receipt) => {
            store.conversationWorktrees.recordCreation(conversation.id, plannedPath, branch, receipt);
          },
        },
      );

      const reader = new Database(dbPath, { readonly: true });
      try {
        expect(hasIncompleteWorktreeSetup(reader, conversation.id)).toBe(false);
      } finally {
        reader.close();
      }
      expect(store.conversationPath(conversation.id)).toBe(realpathSync.native(plannedPath));
    } finally {
      store.close();
    }
  });
});
