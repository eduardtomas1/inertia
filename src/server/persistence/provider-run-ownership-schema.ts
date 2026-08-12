import type Database from "better-sqlite3";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface IndexRow {
  name: string;
  unique: number;
  origin?: string;
}

export function indexColumns(database: Database.Database, name: string): string[] {
  return (database.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as Array<{
    name: string;
  }>).map(({ name: column }) => column);
}

export function validProviderRunOwnershipSchema(
  database: Database.Database,
): boolean {
  const columns = database.prepare(
    "PRAGMA table_info(provider_run_ownership)",
  ).all() as ColumnRow[];
  const expected = [
    ["turn_id", 1, 1],
    ["conversation_id", 1, 0],
    ["run_id", 1, 0],
    ["runtime_generation_id", 1, 0],
    ["system_boot_id", 1, 0],
    ["created_at", 1, 0],
  ] as const;
  if (
    columns.length !== expected.length
    || expected.some(([name, notnull, pk], ordinal) => {
      const column = columns[ordinal];
      return column?.name !== name
        || column.type.toUpperCase() !== "TEXT"
        || column.notnull !== notnull
        || column.pk !== pk;
    })
  ) return false;

  const tableDefinition = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'provider_run_ownership'
  `).get() as { sql: unknown } | undefined;
  const normalizedDefinition = typeof tableDefinition?.sql === "string"
    ? tableDefinition.sql.replace(/\s+/gu, " ").toLowerCase()
    : "";
  const requiredChecks = [
    "check (length(turn_id) between 1 and 200)",
    "check (length(conversation_id) between 1 and 200)",
    "check (length(run_id) between 1 and 200)",
    "check (length(runtime_generation_id) between 38 and 80)",
    "check (length(system_boot_id) between 8 and 80)",
    "check (length(created_at) between 20 and 40)",
  ];
  if (requiredChecks.some((check) => !normalizedDefinition.includes(check))) {
    return false;
  }

  const indexes = database.prepare(
    "PRAGMA index_list(provider_run_ownership)",
  ).all() as IndexRow[];
  const lookup = indexes.find(({ name }) =>
    name === "provider_run_ownership_conversation_idx");
  const uniqueRun = indexes.find(({ unique, origin }) =>
    unique === 1 && origin === "u");
  if (
    !lookup
    || lookup.unique !== 0
    || indexColumns(database, lookup.name).join("\0")
      !== ["conversation_id", "created_at", "turn_id"].join("\0")
    || !uniqueRun
    || indexColumns(database, uniqueRun.name).join("\0") !== "run_id"
  ) return false;

  const parentIndex = (database.prepare(
    "PRAGMA index_list(agent_turns)",
  ).all() as IndexRow[]).find(({ name }) =>
    name === "agent_turns_provider_run_identity_idx");
  if (
    parentIndex?.unique !== 1
    || indexColumns(database, parentIndex.name).join("\0")
      !== ["id", "conversation_id", "run_id"].join("\0")
  ) return false;

  const foreignKeys = database.prepare(
    "PRAGMA foreign_key_list(provider_run_ownership)",
  ).all() as Array<{
    id: number;
    seq: number;
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }>;
  const foreignKeyId = foreignKeys[0]?.id;
  if (
    foreignKeys.length !== 3
    || foreignKeys.some((key) => (
      key.id !== foreignKeyId
      || key.table !== "agent_turns"
      || key.on_delete !== "RESTRICT"
    ))
    || foreignKeys.sort((left, right) => left.seq - right.seq)
      .some((key, ordinal) => (
        key.from !== ["turn_id", "conversation_id", "run_id"][ordinal]
        || key.to !== ["id", "conversation_id", "run_id"][ordinal]
      ))
  ) return false;

  const identities = database.prepare(`
    SELECT turn_id, conversation_id, run_id, runtime_generation_id,
      system_boot_id, created_at
    FROM provider_run_ownership
  `).all() as Array<{
    turn_id: unknown;
    conversation_id: unknown;
    run_id: unknown;
    runtime_generation_id: unknown;
    system_boot_id: unknown;
    created_at: unknown;
  }>;
  return identities.every(({
    turn_id,
    conversation_id,
    run_id,
    runtime_generation_id,
    system_boot_id,
    created_at,
  }) => {
    if (
      typeof turn_id !== "string"
      || turn_id.length < 1
      || turn_id.length > 200
      || typeof conversation_id !== "string"
      || conversation_id.length < 1
      || conversation_id.length > 200
      || typeof run_id !== "string"
      || run_id.length < 1
      || run_id.length > 200
      || typeof runtime_generation_id !== "string"
      || typeof system_boot_id !== "string"
      || typeof created_at !== "string"
      || created_at.length < 20
      || created_at.length > 40
      || !Number.isFinite(Date.parse(created_at))
    ) return false;
    const generationParts = runtime_generation_id.split(":");
    const validGeneration = generationParts.length === 2
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(generationParts[0] ?? "")
      && /^[1-9][0-9]{0,9}$/u.test(generationParts[1] ?? "");
    const validBoot = /^(?:linux|darwin):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(system_boot_id)
      || /^win32:[0-9a-f]{8}$/u.test(system_boot_id)
      || /^test:[0-9a-f-]{36}$/u.test(system_boot_id)
      || system_boot_id === "unavailable";
    return validGeneration && validBoot;
  });
}
