import type { DatabaseMigrationDefinition } from "./catalog";

export const delegationAutomaticWakesMigration: DatabaseMigrationDefinition = {
  name: "PersistDelegationAutomaticWakes",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "delegation_automatic_wakes")) {
      return;
    }
    database.exec(`
      ALTER TABLE app_state
        ADD COLUMN delegation_automatic_wakes INTEGER NOT NULL DEFAULT 1
        CHECK (delegation_automatic_wakes IN (0, 1));
    `);
  },
};
