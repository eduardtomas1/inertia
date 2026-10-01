import { z } from "zod";

const text = z.string().min(1).max(512);
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const pullRequestKeySchema = z.object({
  host: z.literal("github.com"),
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/u).max(200).refine((value) => !value.split("/").some((part) => part === "." || part === "..")),
  number: z.number().int().positive().safe(),
}).strict();
export type PullRequestKey = z.infer<typeof pullRequestKeySchema>;
export const pullRequestStateSchema = z.enum(["open", "closed", "merged"]);
export const pullRequestSnapshotSchema = z.object({
  title: text, state: pullRequestStateSchema, draft: z.boolean(),
  headBranch: text, head: sha, baseBranch: text, base: sha,
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  author: text, updatedAt: z.string().datetime(), syncedAt: z.string().datetime(),
  mergeState: text, reviewDecision: z.string().max(100).nullable(),
  checks: z.object({ total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), complete: z.boolean() }).strict(),
  unresolvedReviews: z.number().int().nonnegative(), reviewsComplete: z.boolean(),
  canUpdateBranch: z.boolean(),
}).strict();
export type PullRequestSnapshot = z.infer<typeof pullRequestSnapshotSchema>;
export const pullRequestStackSchema = z.object({
  id: text, number: z.number().int().positive().safe(), base: text,
  layers: z.array(z.object({ number: z.number().int().positive().safe(), headBranch: text,
    head: sha.nullable(), state: pullRequestStateSchema, draft: z.boolean() }).strict()).min(1).max(100),
}).strict().refine((stack) => new Set(stack.layers.map((layer) => layer.number)).size === stack.layers.length);
export type PullRequestStack = z.infer<typeof pullRequestStackSchema>;
export const linkedPullRequestSchema = pullRequestKeySchema.extend({
  source: z.enum(["manual", "created", "stack", "stack-dismissed"]), linkedAt: z.string().datetime(),
  snapshot: pullRequestSnapshotSchema.nullable(), stack: pullRequestStackSchema.nullable(),
  syncError: z.string().max(1000).nullable(),
}).strict();
export type LinkedPullRequest = z.infer<typeof linkedPullRequestSchema>;
export const stackActionSchema = z.enum(["merge", "rebase"]);
export const stackReviewSchema = z.object({
  id: z.string().uuid(), conversationId: z.string().uuid(), key: pullRequestKeySchema,
  action: stackActionSchema, stack: pullRequestStackSchema,
  layers: z.array(z.object({ number: z.number().int().positive(), snapshot: pullRequestSnapshotSchema }).strict()).min(1).max(100),
  expiresAt: z.string().datetime(), blockers: z.array(z.string().max(1000)).max(200),
}).strict();
export type StackReview = z.infer<typeof stackReviewSchema>;
export const stackOperationSchema = z.object({
  id: z.string().uuid(), key: pullRequestKeySchema, stackNumber: z.number().int().positive(), action: stackActionSchema,
  state: z.enum(["running", "pending", "completed", "failed", "unknown"]),
  completedLayers: z.number().int().nonnegative(), message: z.string().max(1000), updatedAt: z.string().datetime(),
}).strict();
export type StackOperation = z.infer<typeof stackOperationSchema>;
export const pullRequestsResultSchema = z.object({
  kind: z.literal("conversation.pull-requests"), conversationId: z.string().uuid(),
  links: z.array(linkedPullRequestSchema).max(200), operations: z.array(stackOperationSchema).max(20),
}).strict();
export type PullRequestsResult = z.infer<typeof pullRequestsResultSchema>;
export const stackReviewResultSchema = z.object({ kind: z.literal("conversation.stack-review"), review: stackReviewSchema }).strict();
export type StackReviewResult = z.infer<typeof stackReviewResultSchema>;
export function pullRequestIdentity(key: PullRequestKey): string {
  return `${key.host}/${key.repository.toLowerCase()}#${key.number}`;
}
export function pullRequestUrl(key: PullRequestKey): string { return `https://${key.host}/${key.repository}/pull/${key.number}`; }
export function parsePullRequestUrl(raw: string): PullRequestKey | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
    const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(url.pathname);
    if (!match) return null;
    const key = pullRequestKeySchema.safeParse({ host: url.hostname, repository: match[1]!.toLowerCase(), number: Number(match[2]) });
    return key.success ? key.data : null;
  } catch { return null; }
}
