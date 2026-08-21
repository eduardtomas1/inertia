import type { DatabaseMigrationDefinition } from "./catalog";

export const persistDiscordReleaseRepositoryUrl: DatabaseMigrationDefinition = {
  name: "PersistDiscordReleaseRepositoryUrl",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "discord_release_repository_url")) {
      return;
    }
    database.exec(`
      ALTER TABLE app_state
        ADD COLUMN discord_release_repository_url TEXT NOT NULL DEFAULT ''
        CHECK (length(discord_release_repository_url) <= 500);
    `);
  },
};
