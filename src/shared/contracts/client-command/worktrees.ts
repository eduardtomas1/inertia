import { z } from "zod";

import { requestBase } from "./common";

/** Worktree inventory and cleanup for one project's repository (main window only). */
export const worktreeCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("worktree.list"),
    payload: z.object({ projectId: z.string().uuid() }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("worktree.remove"),
    payload: z.object({
      projectId: z.string().uuid(),
      path: z.string().min(1).max(4_096).refine(
        (path) => !/[\0\r\n]/u.test(path),
        "Invalid worktree path.",
      ),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("worktree.prune"),
    payload: z.object({ projectId: z.string().uuid() }).strict(),
  }).strict(),
] as const;
