import { isAbsolute, relative, resolve } from "node:path";

import type Database from "better-sqlite3";

import type { RegisteredWorktreeIdentity } from "../git";
import { WorkspacePathAuthority } from "../workspace-path-authority";
import {
  serializeWorktreeFilesystemReceipt,
} from "../worktree-filesystem-identity";
import { conversationWorktreeOwnershipFromRow } from "./codecs";
import type { ConversationRow, ConversationWorktreeOwnershipRow } from "./rows";
import type { StoredConversationWorktreeOwnership } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/u;
const REPOSITORY_IDENTITY_PATTERN = /^[0-9a-f]{64}$/u;

function pathsEqual(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

function validWorktreePlan(path: string, branch: string, token: string): boolean {
  return isAbsolute(path)
    && Buffer.byteLength(path, "utf8") <= 4_096
    && !path.includes("\0")
    && Buffer.byteLength(branch, "utf8") >= 1
    && Buffer.byteLength(branch, "utf8") <= 255
    && !branch.includes("\0")
    && UUID_PATTERN.test(token);
}

export class ConversationWorktreeRemovalError extends Error {}

export class ConversationWorktreeRepository {
  private readonly pathAuthority: WorkspacePathAuthority;

  constructor(
    private readonly database: Database.Database,
    private readonly requireConversation: (
      conversationId: string,
    ) => ConversationRow,
  ) {
    this.pathAuthority = new WorkspacePathAuthority(database);
  }

  get(conversationId: string): StoredConversationWorktreeOwnership | null {
    this.requireConversation(conversationId);
    const row = this.database.prepare(`
      SELECT * FROM conversation_worktree_ownership
      WHERE conversation_id = ?
    `).get(conversationId) as ConversationWorktreeOwnershipRow | undefined;
    return row ? conversationWorktreeOwnershipFromRow(row) : null;
  }

  assertProjectRemovalAllowed(projectId: string): void {
    const blocking = this.database.prepare(`
      SELECT ownership.conversation_id AS conversation_id,
        ownership.creation_state AS creation_state
      FROM conversation_worktree_ownership AS ownership
      JOIN conversations
        ON conversations.id = ownership.conversation_id
      WHERE conversations.project_id = ?
        AND ownership.owns_worktree = 1
      LIMIT 1
    `).get(projectId) as {
      conversation_id: string;
      creation_state: "creating" | "created";
    } | undefined;
    if (!blocking) return;
    throw new ConversationWorktreeRemovalError(
      "Resolve this project's isolated chat worktrees before removing it. "
      + "Delete each affected chat individually; if Inertia preserves a "
      + "registered worktree, remove it manually with Git and retry that "
      + "chat deletion.",
    );
  }

  beginCreation(
    conversationId: string,
    path: string,
    branch: string,
    ownershipToken: string,
  ): void {
    const conversation = this.requireConversation(conversationId);
    if (
      conversation.worktree_path !== null
      || !validWorktreePlan(path, branch, ownershipToken)
    ) {
      throw new Error("The conversation worktree creation plan is invalid.");
    }
    this.database.prepare(`
      INSERT INTO conversation_worktree_ownership (
        conversation_id, path, branch, owns_worktree, creation_state,
        ownership_token
      ) VALUES (?, ?, ?, 1, 'creating', ?)
    `).run(conversationId, path, branch, ownershipToken);
  }

  rejectCreation(conversationId: string): void {
    const result = this.database.prepare(`
      DELETE FROM conversation_worktree_ownership
      WHERE conversation_id = ?
        AND owns_worktree = 1
        AND creation_state = 'creating'
    `).run(conversationId);
    if (result.changes !== 1) {
      throw new Error(
        "The rejected conversation worktree did not match its durable plan.",
      );
    }
  }

  recordCreation(
    conversationId: string,
    plannedPath: string,
    plannedBranch: string,
    identity: RegisteredWorktreeIdentity,
  ): void {
    if (
      !validWorktreePlan(plannedPath, plannedBranch, identity.ownershipToken)
      || identity.branch !== plannedBranch
      || !isAbsolute(identity.path)
      || Buffer.byteLength(identity.path, "utf8") > 4_096
      || identity.path.includes("\0")
      || !GIT_OBJECT_PATTERN.test(identity.head)
      || !identity.worktreeId
      || Buffer.byteLength(identity.worktreeId, "utf8") > 255
      || identity.worktreeId.includes("\0")
      || !REPOSITORY_IDENTITY_PATTERN.test(identity.repositoryIdentity)
    ) {
      throw new Error("The conversation worktree ownership receipt is invalid.");
    }
    const filesystemIdentity = serializeWorktreeFilesystemReceipt(
      identity.filesystemReceipt,
    );
    this.database.transaction(() => {
      const ownership = this.database.prepare(`
        UPDATE conversation_worktree_ownership
        SET path = ?, branch = ?, creation_state = 'created',
          worktree_id = ?, repository_identity = ?,
          filesystem_identity_json = ?, branch_head = ?
        WHERE conversation_id = ?
          AND path = ?
          AND branch = ?
          AND owns_worktree = 1
          AND creation_state = 'creating'
          AND ownership_token = ?
      `).run(
        identity.path,
        identity.branch,
        identity.worktreeId,
        identity.repositoryIdentity,
        filesystemIdentity,
        identity.head,
        conversationId,
        plannedPath,
        plannedBranch,
        identity.ownershipToken,
      );
      if (ownership.changes !== 1) {
        throw new Error(
          "The conversation worktree receipt did not match its durable plan.",
        );
      }
      const conversation = this.database.prepare(`
        UPDATE conversations SET worktree_path = ?, branch = ?
        WHERE id = ? AND worktree_path IS NULL
      `).run(identity.path, identity.branch, conversationId);
      if (conversation.changes !== 1) {
        throw new Error(
          "The conversation no longer matches its worktree creation plan.",
        );
      }
      this.pathAuthority.enrollConversationRow(
        this.requireConversation(conversationId),
      );
    })();
  }

  transfer(
    sourceConversationId: string,
    targetConversationId: string,
  ): void {
    if (sourceConversationId === targetConversationId) {
      throw new Error("The conversation worktree owner cannot transfer to itself.");
    }
    this.database.transaction(() => {
      const source = this.get(sourceConversationId);
      const target = this.get(targetConversationId);
      if (
        !source?.ownsWorktree
        || source.creationState !== "created"
        || target?.ownsWorktree !== false
        || !pathsEqual(source.path, target.path)
      ) {
        throw new Error("The shared conversation worktree ownership is invalid.");
      }
      const removedTarget = this.database.prepare(`
        DELETE FROM conversation_worktree_ownership
        WHERE conversation_id = ? AND owns_worktree = 0
      `).run(targetConversationId);
      const transferred = this.database.prepare(`
        UPDATE conversation_worktree_ownership
        SET conversation_id = ?
        WHERE conversation_id = ?
          AND owns_worktree = 1
          AND creation_state = 'created'
      `).run(targetConversationId, sourceConversationId);
      if (removedTarget.changes !== 1 || transferred.changes !== 1) {
        throw new Error("The shared conversation worktree ownership changed.");
      }
    })();
  }
}
