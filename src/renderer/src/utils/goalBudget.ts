export const MAX_GOAL_TOKEN_BUDGET = 1_000_000_000;

export function parseGoalTokenBudget(
  value: string,
): number | null | undefined {
  const clean = value.trim();
  if (!clean) return null;
  const parsed = Number(clean);
  return Number.isSafeInteger(parsed)
    && parsed >= 1
    && parsed <= MAX_GOAL_TOKEN_BUDGET
    ? parsed
    : undefined;
}
