import type Database from "better-sqlite3";

export function contextPacketTriggersAreValid(
  database: Database.Database,
): boolean {
  const required: Array<[string, string[]]> = [
    ["conversation_context_packets_immutable", [
      "before update of", "on conversation_context_packets",
    ]],
    ["conversation_context_packets_consume_once", [
      "on conversation_context_packets", "when old.consumed_message_id is not null",
    ]],
    ["conversation_context_packets_discard_source_drafts", [
      "after delete on conversations", "delete from conversation_context_packets",
    ]],
    ["conversation_context_packets_draft_limit", [
      "before insert on conversation_context_packets", "count(*) from conversation_context_packets",
    ]],
  ];
  return required.every(([name, fragments]) => {
    const trigger = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = ?
    `).get(name) as { sql: unknown } | undefined;
    const normalized = typeof trigger?.sql === "string"
      ? trigger.sql.replace(/\s+/gu, " ").toLowerCase()
      : "";
    return fragments.every((fragment) => normalized.includes(fragment))
      && (name.endsWith("_discard_source_drafts") || /raise\s*\(\s*abort/u.test(normalized));
  });
}
