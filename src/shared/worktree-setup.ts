import { z } from "zod";

export const worktreeSetupSummarySchema = z.strictObject({
  actionName: z.string().min(1).max(80),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "interrupted", "skipped"]),
  attempt: z.number().int().min(0),
  detail: z.string().max(500),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type WorktreeSetupSummary = z.infer<typeof worktreeSetupSummarySchema>;
export const WORKTREE_SETUP_TIMEOUT_MS = 10 * 60_000;
export const WORKTREE_SETUP_OUTPUT_LIMIT = 16_384;

export function worktreeSetupReady(setup: WorktreeSetupSummary | null | undefined): boolean {
  return !setup || setup.status === "succeeded" || setup.status === "skipped";
}

export function parseWorktreeSetup(value: string | null | undefined): WorktreeSetupSummary | null {
  if (!value) return null;
  return worktreeSetupSummarySchema.parse(JSON.parse(value));
}
