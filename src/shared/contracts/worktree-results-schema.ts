import { worktreeActionOutcomeSchema, worktreeListSchema } from "../worktrees";

export const worktreeResultValidators = {
  "worktree.list": (value: Record<string, unknown>) => worktreeListSchema.safeParse(value.list).success,
  "worktree.action": (value: Record<string, unknown>) => worktreeActionOutcomeSchema.safeParse(value.outcome).success,
};
