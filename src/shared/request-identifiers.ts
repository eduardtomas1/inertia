export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isProjectRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || /[\0\r\n]/u.test(value)
    || /^[\\/]/u.test(value)
    || /^[A-Za-z]:/u.test(value)
  ) return false;
  return !value.split(/[\\/]/u).some((segment) => segment === "..");
}
