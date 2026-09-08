export function gitBranch(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const branch = value as Record<string, unknown>;
  return typeof branch.name === "string"
    && typeof branch.current === "boolean"
    && typeof branch.remote === "boolean"
    && (branch.checkedOut === undefined || typeof branch.checkedOut === "boolean")
    && (branch.worktreePath === null || typeof branch.worktreePath === "string");
}
