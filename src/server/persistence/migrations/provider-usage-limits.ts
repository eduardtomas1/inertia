import type { DatabaseMigrationDefinition } from "./catalog";

export const providerUsageLimitsMigration: DatabaseMigrationDefinition = {
  name: "ProviderUsageSourcesAndResetAttempts",
  up: `
    CREATE TABLE IF NOT EXISTS usage_limit_sources (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS usage_reset_attempts (
      id TEXT PRIMARY KEY, credit_key TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL, account_key TEXT NOT NULL, credit_id TEXT,
      confirmation_json TEXT NOT NULL, outcome TEXT,
      attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1))
    );
  `,
};
