import type { DatabaseMigrationDefinition } from "./catalog";
export const pullRequestsMigration: DatabaseMigrationDefinition = {
  name: "PersistConversationPullRequestsAndStackOperations",
  up: `
    CREATE TABLE conversation_pull_requests (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)),
      PRIMARY KEY(conversation_id, identity)
    );
    CREATE TABLE pull_request_stack_operations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      stack_identity TEXT NOT NULL,
      review_json TEXT NOT NULL CHECK(json_valid(review_json)),
      operation_json TEXT CHECK(operation_json IS NULL OR json_valid(operation_json)),
      merge_uuid TEXT,
      state TEXT NOT NULL CHECK(state IN ('prepared','running','pending','completed','failed','unknown'))
    );
    CREATE INDEX pull_request_stack_operation_owner ON pull_request_stack_operations(conversation_id);
    CREATE UNIQUE INDEX pull_request_stack_active_operation ON pull_request_stack_operations(stack_identity)
      WHERE state IN ('running','pending','unknown');
    CREATE TRIGGER pull_request_stack_protect_owner BEFORE DELETE ON conversations BEGIN
      SELECT RAISE(ABORT, 'Check the pending GitHub stack action before deleting this chat.')
      WHERE EXISTS (SELECT 1 FROM pull_request_stack_operations WHERE conversation_id=OLD.id AND state IN ('running','pending','unknown'));
    END;
  `,
};
