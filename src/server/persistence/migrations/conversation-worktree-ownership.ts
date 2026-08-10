import type { DatabaseMigrationDefinition } from "./catalog";

export const conversationWorktreeOwnershipMigration = {
  name: "PersistConversationWorktreeOwnership",
  up: `
    CREATE TABLE IF NOT EXISTS conversation_worktree_ownership (
      conversation_id TEXT PRIMARY KEY
        REFERENCES conversations(id) ON DELETE CASCADE,
      path TEXT NOT NULL
        CHECK (length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
      branch TEXT
        CHECK (branch IS NULL OR length(CAST(branch AS BLOB)) BETWEEN 1 AND 255),
      owns_worktree INTEGER NOT NULL DEFAULT 0
        CHECK (owns_worktree IN (0, 1)),
      creation_state TEXT NOT NULL DEFAULT 'external'
        CHECK (creation_state IN ('external', 'creating', 'created')),
      ownership_token TEXT
        CHECK (ownership_token IS NULL OR length(ownership_token) = 36),
      worktree_id TEXT
        CHECK (
          worktree_id IS NULL
          OR length(CAST(worktree_id AS BLOB)) BETWEEN 1 AND 255
        ),
      repository_identity TEXT
        CHECK (
          repository_identity IS NULL
          OR length(repository_identity) = 64
        ),
      filesystem_identity_json TEXT
        CHECK (
          filesystem_identity_json IS NULL
          OR length(CAST(filesystem_identity_json AS BLOB)) BETWEEN 1 AND 1024
        ),
      branch_head TEXT
        CHECK (branch_head IS NULL OR length(branch_head) BETWEEN 40 AND 64),
      CHECK (
        (
          owns_worktree = 0
          AND creation_state = 'external'
          AND ownership_token IS NULL
          AND worktree_id IS NULL
          AND repository_identity IS NULL
          AND filesystem_identity_json IS NULL
          AND branch_head IS NULL
        )
        OR (
          owns_worktree = 1
          AND creation_state = 'creating'
          AND branch IS NOT NULL
          AND ownership_token IS NOT NULL
          AND worktree_id IS NULL
          AND repository_identity IS NULL
          AND filesystem_identity_json IS NULL
          AND branch_head IS NULL
        )
        OR (
          owns_worktree = 1
          AND creation_state = 'created'
          AND branch IS NOT NULL
          AND ownership_token IS NOT NULL
          AND worktree_id IS NOT NULL
          AND repository_identity IS NOT NULL
          AND filesystem_identity_json IS NOT NULL
          AND branch_head IS NOT NULL
        )
      )
    );
    INSERT OR IGNORE INTO conversation_worktree_ownership (
      conversation_id, path, branch, owns_worktree, creation_state
    )
    SELECT id, worktree_path, branch, 0, 'external'
    FROM conversations
    WHERE worktree_path IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS conversation_worktree_ownership_project_delete
    BEFORE DELETE ON projects
    BEGIN
      SELECT RAISE(
        ABORT,
        'Resolve this project''s isolated chat worktrees before removing it. Delete each affected chat individually; if Inertia preserves a registered worktree, remove it manually with Git and retry that chat deletion.'
      )
      WHERE EXISTS (
        SELECT 1
        FROM conversation_worktree_ownership AS ownership
        JOIN conversations
          ON conversations.id = ownership.conversation_id
        WHERE conversations.project_id = OLD.id
          AND ownership.owns_worktree = 1
      );
    END;
  `,
} satisfies DatabaseMigrationDefinition;
