import type { DatabaseMigrationDefinition } from "./catalog";

export const persistTurnContinuationEvidence: DatabaseMigrationDefinition = {
  name: "PersistTurnContinuationEvidence",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(agent_turns)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "continuation_reason_code")) return;
    database.exec(`
      ALTER TABLE agent_turns
        ADD COLUMN continuation_reason_code TEXT
        CHECK (
          continuation_reason_code IS NULL
          OR continuation_reason_code IN (
            'first-turn',
            'same-continuation',
            'same-route-without-session',
            'supported-model-switch',
            'supported-performance-mode-switch',
            'missing-continuation-identity',
            'harness-changed',
            'backend-profile-changed',
            'backend-configuration-changed',
            'backend-endpoint-changed',
            'provider-installation-changed',
            'provider-installation-unverified',
            'incompatible-model-changed',
            'incompatible-performance-mode-changed',
            'stale-provider-session'
          )
        );
    `);
  },
};
