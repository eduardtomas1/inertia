import type { DatabaseMigrationDefinition } from "./catalog";

export const reviewBriefMigration: DatabaseMigrationDefinition = {
  name: "PersistReviewBrief",
  up: `CREATE TABLE review_briefs (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    brief_json TEXT NOT NULL CHECK(length(brief_json) <= 65536)
  );`,
};
