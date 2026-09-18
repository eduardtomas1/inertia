import type Database from "better-sqlite3";

export const MAX_CACHED_STATEMENTS_PER_DATABASE = 32;

const statementCaches = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>();

export function cachedStatement(
  database: Database.Database,
  sql: string,
): Database.Statement {
  let cache = statementCaches.get(database);
  if (!cache) {
    cache = new Map();
    statementCaches.set(database, cache);
  }
  const cached = cache.get(sql);
  if (cached) return cached;
  const statement = database.prepare(sql);
  if (cache.size >= MAX_CACHED_STATEMENTS_PER_DATABASE) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(sql, statement);
  return statement;
}
