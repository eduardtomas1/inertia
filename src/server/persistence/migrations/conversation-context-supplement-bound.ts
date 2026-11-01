import type { DatabaseMigrationDefinition } from "./catalog";

export const conversationContextSupplementBoundMigration: DatabaseMigrationDefinition = {
  name: "RaiseConversationContextSupplementBound",
  foreignKeys: "off",
  up: (database) => {
    const table = "conversation_context_packets";
    const replacement = "conversation_context_packets_v110";
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const header = /^CREATE TABLE (?:"conversation_context_packets"|conversation_context_packets)\s*\(/u;
    const bound = /(length\(CAST\(supplement_json AS BLOB\)\) BETWEEN 2 AND )(4096|12288)(?!\d)/gu;
    const current = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql: string } | undefined;
    const bounds = current && header.exec(current.sql) ? [...current.sql.matchAll(bound)].map((match) => match[2]) : [];
    if (bounds.length !== 1) throw new Error("The conversation context packet schema is not the expected version.");
    if (bounds[0] === "12288") return;
    const triggers = database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND sql IS NOT NULL
        AND (tbl_name = ? OR instr(sql, ?) > 0)
      ORDER BY name
    `).all(table, table) as { name: string; sql: string }[];
    const indexes = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
      ORDER BY name
    `).all(table) as { sql: string }[];
    const columns = (database.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[])
      .map(({ name }) => quote(name)).join(", ");
    const rows = (database.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: number }).count;
    for (const { name } of triggers) database.exec(`DROP TRIGGER ${quote(name)}`);
    database.exec(current!.sql.replace(header, `CREATE TABLE ${quote(replacement)} (`)
      .replace(bound, (_match, prefix: string) => `${prefix}12288`));
    database.exec(`INSERT INTO ${quote(replacement)} (${columns}) SELECT ${columns} FROM ${quote(table)}`);
    const copied = (database.prepare(`SELECT COUNT(*) AS count FROM ${quote(replacement)}`).get() as { count: number }).count;
    if (copied !== rows) throw new Error("The conversation context packet rebuild lost rows.");
    database.exec(`DROP TABLE ${quote(table)}`);
    database.exec(`ALTER TABLE ${quote(replacement)} RENAME TO ${quote(table)}`);
    for (const { sql } of indexes) database.exec(sql);
    for (const { sql } of triggers) database.exec(sql);
  },
};
