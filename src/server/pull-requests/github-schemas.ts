import { z } from "zod";
import { pullRequestSnapshotSchema, pullRequestStackSchema, type PullRequestKey, type PullRequestSnapshot, type PullRequestStack } from "../../shared/pull-requests";
import { RuntimeRequestError } from "../runtime-errors";
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const count = z.number().int().nonnegative();
const pageInfo = z.object({ hasNextPage: z.boolean() });
const contextSchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("CheckRun"), status: z.string(), conclusion: z.string().nullable() }),
  z.object({ __typename: z.literal("StatusContext"), state: z.string() }),
]);
export const prSchema = z.object({
  id: z.string().min(1), number: z.number().int().positive(), title: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(),
  headRefName: z.string(), headRefOid: sha, baseRefName: z.string(), baseRefOid: sha,
  additions: count, deletions: count, updatedAt: z.string().datetime(), author: z.object({ login: z.string() }).nullable(),
  mergeStateStatus: z.string(), reviewDecision: z.string().nullable(), maintainerCanModify: z.boolean(),
  headRepository: z.object({ viewerPermission: z.string().nullable() }).nullable(),
  repository: z.object({ nameWithOwner: z.string(), viewerPermission: z.string().nullable() }),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: sha, statusCheckRollup: z.object({
    contexts: z.object({ totalCount: count, pageInfo, nodes: z.array(contextSchema).max(100) }),
  }).nullable() }) })).max(1) }),
  reviewThreads: z.object({ totalCount: count, pageInfo, nodes: z.array(z.object({ isResolved: z.boolean() })).max(100) }),
});
export type GitHubPr = z.infer<typeof prSchema>;
export function decodePr(raw: unknown, key: PullRequestKey): GitHubPr {
  const decoded = z.object({ data: z.object({ repository: z.object({ pullRequest: prSchema }) }), errors: z.undefined().optional() }).safeParse(raw);
  if (!decoded.success) throw new RuntimeRequestError("GitHub did not return a complete pull request. Check access and refresh.");
  const pr = decoded.data.data.repository.pullRequest;
  if (pr.number !== key.number || pr.repository.nameWithOwner.toLowerCase() !== key.repository.toLowerCase()) throw new RuntimeRequestError("GitHub returned a different pull request identity.");
  return pr;
}
const hasWrite = (value: string | null | undefined): boolean => ["WRITE", "MAINTAIN", "ADMIN"].includes(value ?? "");
export function snapshotForPr(pr: GitHubPr, now: string): PullRequestSnapshot {
  const commit = pr.commits.nodes[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts;
  let passed = 0, pending = 0, failed = 0;
  for (const context of contexts?.nodes ?? []) {
    if (context.__typename === "StatusContext") {
      if (context.state === "SUCCESS") passed++;
      else if (context.state === "PENDING" || context.state === "EXPECTED") pending++;
      else failed++;
    } else if (context.status !== "COMPLETED") pending++;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(context.conclusion ?? "")) passed++;
    else failed++;
  }
  return pullRequestSnapshotSchema.parse({
    title: pr.title, state: pr.state.toLowerCase(), draft: pr.isDraft, headBranch: pr.headRefName, head: pr.headRefOid,
    baseBranch: pr.baseRefName, base: pr.baseRefOid, additions: pr.additions, deletions: pr.deletions,
    author: pr.author?.login ?? "ghost", updatedAt: pr.updatedAt, syncedAt: now, mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision,
    checks: { total: contexts?.totalCount ?? 0, passed, pending, failed,
      complete: commit?.oid === pr.headRefOid && (!contexts || (!contexts.pageInfo.hasNextPage && contexts.totalCount === contexts.nodes.length)) },
    unresolvedReviews: pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    reviewsComplete: !pr.reviewThreads.pageInfo.hasNextPage && pr.reviewThreads.totalCount === pr.reviewThreads.nodes.length,
    canUpdateBranch: hasWrite(pr.headRepository?.viewerPermission) || (pr.maintainerCanModify && hasWrite(pr.repository.viewerPermission)),
  });
}
const rawStack = z.object({ id: z.union([z.string(), z.number()]).optional(), node_id: z.string().optional(), number: z.number().int().positive(),
  base: z.union([z.string(), z.object({ ref: z.string() })]),
  pull_requests: z.array(z.object({ number: z.number().int().positive(), head: z.object({ ref: z.string(), sha: sha.optional() }),
    state: z.enum(["open", "closed", "merged"]), merged_at: z.string().nullable().optional(), draft: z.boolean().optional() })).min(1).max(100),
});
export function decodeStack(raw: unknown, key: PullRequestKey): PullRequestStack | null {
  const decoded = z.array(rawStack).max(1).safeParse(raw);
  if (!decoded.success) throw new RuntimeRequestError("GitHub returned an unreadable native stack.");
  const stack = decoded.data[0];
  if (!stack) return null;
  if (!stack.pull_requests.some((layer) => layer.number === key.number)) throw new RuntimeRequestError("GitHub returned a stack for a different pull request.");
  return pullRequestStackSchema.parse({ id: String(stack.node_id ?? stack.id ?? stack.number), number: stack.number,
    base: typeof stack.base === "string" ? stack.base : stack.base.ref,
    layers: stack.pull_requests.map((layer) => ({ number: layer.number, headBranch: layer.head.ref, head: layer.head.sha ?? null,
      state: layer.merged_at ? "merged" : layer.state, draft: layer.draft ?? false })) });
}
export const mergeResponseSchema = z.object({ status: z.enum(["pending", "merged", "enqueued", "failed"]),
  details: z.object({ uuid: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u).optional(), message: z.string().optional() }) });
export type MergeResponse = z.infer<typeof mergeResponseSchema>;
export const branchReadSchema = z.object({ errors: z.undefined().optional(), data: z.object({
  processed: z.array(z.object({ headRefOid: sha }).nullable()),
  repository: z.object({ pullRequest: z.object({ id: z.string().min(1), headRefOid: sha,
    baseRef: z.object({ target: z.object({ oid: sha }), compare: z.object({ behindBy: count }) }) }) }),
}) });
export const branchUpdateSchema = z.object({ errors: z.undefined().optional(), data: z.object({
  updatePullRequestBranch: z.object({ pullRequest: z.object({ headRefOid: sha }) }),
}) });
