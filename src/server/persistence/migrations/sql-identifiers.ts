const SQLITE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * SQLite does not bind table or column names. Every dynamic migration
 * identifier must therefore pass an explicit call-site allowlist before it is
 * quoted and interpolated into schema SQL.
 */
export function quotedSqlIdentifier(
  value: string,
  allowed: readonly string[],
): string {
  if (!SQLITE_IDENTIFIER.test(value) || !allowed.includes(value)) {
    throw new Error("The migration SQL identifier is not allowlisted.");
  }
  return `"${value}"`;
}
