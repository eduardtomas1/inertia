function redactString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[redacted]");
  }
  return result;
}

const REDACTED_OVER_DEPTH = "[redacted:over-depth]";

/**
 * Removes exact process-local bridge credentials before provider-controlled
 * payloads can become activity, transcript text, metadata, diagnostics, or
 * persisted state. The traversal runs only on turns with a credentialed MCP
 * bridge; ordinary provider runs return their original payload by identity.
 */
export function redactHostToolPayload<T>(
  value: T,
  secrets: readonly string[],
): T {
  if (secrets.length === 0) return value;
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return redactString(current, secrets);
    if (current === null || typeof current !== "object") return current;
    if (depth >= 32) return REDACTED_OVER_DEPTH;
    if (Array.isArray(current)) {
      return current.map((entry) => visit(entry, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(current).map(([key, entry]) => [
        redactString(key, secrets),
        visit(entry, depth + 1),
      ]),
    );
  };
  return visit(value, 0) as T;
}
