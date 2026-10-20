/** Upper bound for the optional per-turn Claude spend limit, in USD. */
export const MAX_CLAUDE_TURN_BUDGET_USD = 10_000;

/** A positive USD amount up to the bound, with at most two decimal places. */
export function isValidClaudeTurnBudgetUsd(value: unknown): value is number {
  // Every in-range number prints in plain decimal notation, so the pattern
  // checks the exact value the user entered rather than a float product.
  return typeof value === "number" && Number.isFinite(value) && value > 0
    && value <= MAX_CLAUDE_TURN_BUDGET_USD && /^\d+(?:\.\d{1,2})?$/u.test(String(value));
}
