import type { DatabaseMigrationDefinition } from "./catalog";

export const extendTodosMigration: DatabaseMigrationDefinition = {
  name: "ExtendTodos",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(todos)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const definitions = [
      ["due_time", `TEXT
        CHECK (due_time IS NULL OR (length(due_time) = 5 AND substr(due_time, 3, 1) = ':'))`],
      ["project_id", `TEXT
        REFERENCES projects(id) ON DELETE SET NULL`],
      ["linked_at", `TEXT
        CHECK (linked_at IS NULL OR length(linked_at) BETWEEN 20 AND 40)`],
    ] as const;
    for (const [name, definition] of definitions) {
      const existing = columns.find((column) => column.name === name);
      if (existing && (existing.type !== "TEXT" || existing.notnull !== 0)) {
        throw new Error("Unexpected task column.");
      }
      if (!existing) database.exec(`ALTER TABLE todos ADD COLUMN ${name} ${definition};`);
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS todos_project_idx
        ON todos(project_id);
      DROP TRIGGER IF EXISTS todos_count_limit;
      CREATE TRIGGER todos_count_limit
        BEFORE INSERT ON todos
        WHEN NEW.completed_at IS NULL
          AND (SELECT COUNT(*) FROM todos WHERE completed_at IS NULL) >= 200
        BEGIN
          SELECT RAISE(ABORT, 'task count limit exceeded');
        END;
    `);
  },
};
