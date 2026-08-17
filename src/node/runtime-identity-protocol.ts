const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function validRuntimeGenerationId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  return parts.length === 2
    && UUID_PATTERN.test(parts[0] ?? "")
    && /^[1-9][0-9]{0,9}$/u.test(parts[1] ?? "");
}

export function validSystemBootId(value: unknown): value is string {
  return typeof value === "string" && (
    /^(?:linux|darwin):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    || /^win32:[0-9a-f]{8}$/u.test(value)
    || /^test:[0-9a-f-]{36}$/u.test(value)
    || value === "unavailable"
  );
}
