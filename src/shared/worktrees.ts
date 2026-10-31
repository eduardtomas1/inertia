import { z } from "zod";

/** Bounds shared by the runtime inventory and its renderer boundary. */
export const MAX_LISTED_WORKTREES = 200;
export const MAX_WORKTREE_STATUS_ENTRIES = 2_000;

const threadStatusSchema = z.enum([
  "idle",
  "running",
  "needs-input",
  "completed",
  "failed",
]);

/**
 * `repository`: inside the project's repository root (shown relative to it).
 * `inertia`: inside Inertia's managed worktree folder (shown absolute).
 * `external`: anywhere else; only the folder name is shown.
 */
export const worktreeLocationSchema = z.enum(["repository", "inertia", "external"]);

export const worktreeEntrySchema = z.object({
  path: z.string().min(1).max(4_096),
  location: worktreeLocationSchema,
  branch: z.string().min(1).max(4_096).nullable(),
  head: z.string().regex(/^[0-9a-f]{40,64}$/u).nullable(),
  isMain: z.boolean(),
  owned: z.boolean(),
  conversationId: z.string().uuid().nullable(),
  title: z.string().max(1_000).nullable(),
  chatStatus: threadStatusSchema.nullable(),
  /** Other chats whose checkout is this worktree without owning it. */
  sharedChatCount: z.number().int().min(0),
  /** Modified, staged or untracked files; null when Git could not tell. */
  dirty: z.boolean().nullable(),
  changeCount: z.number().int().min(0).max(MAX_WORKTREE_STATUS_ENTRIES).nullable(),
  changeCountTruncated: z.boolean(),
  /** Ignored files (for example build output or .env) that removal would delete. */
  ignoredFiles: z.boolean().nullable(),
  locked: z.boolean(),
  prunable: z.boolean(),
  removal: z.discriminatedUnion("allowed", [
    z.object({ allowed: z.literal(true) }).strict(),
    z.object({ allowed: z.literal(false), reason: z.string().min(1).max(1_000) }).strict(),
  ]),
}).strict();

export const worktreeListSchema = z.object({
  projectId: z.string().uuid(),
  worktrees: z.array(worktreeEntrySchema).max(MAX_LISTED_WORKTREES),
  truncated: z.boolean(),
}).strict();

export const worktreeActionOutcomeSchema = z.object({
  action: z.enum(["remove", "prune"]),
  message: z.string().min(1).max(10_000),
  branchDeleted: z.boolean(),
  /**
   * Git unregistered the worktree but part of its folder is still on disk;
   * the message names the folder to delete by hand.
   */
  partial: z.literal(true).optional(),
}).strict();

export type WorktreeLocation = z.infer<typeof worktreeLocationSchema>;
export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;
export type WorktreeList = z.infer<typeof worktreeListSchema>;
export type WorktreeActionOutcome = z.infer<typeof worktreeActionOutcomeSchema>;
