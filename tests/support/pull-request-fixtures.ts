import type { LinkedPullRequest, PullRequestKey, PullRequestSnapshot, PullRequestStack } from "../../src/shared/pull-requests";
export const PR_REPOSITORY = "acme/workspace";
export const prKey = (number = 42, repository = PR_REPOSITORY): PullRequestKey => ({ host: "github.com", repository, number });
export const prSha = (number: number): string => number.toString(16).padStart(40, "0");
export function prSnapshot(number = 42): PullRequestSnapshot {
  return { title: number === 41 ? "Add workspace navigation" : "Keep related pull requests together", state: "open", draft: false,
    headBranch: number === 41 ? "feat/navigation" : "feat/linked-pull-requests", head: prSha(number),
    baseBranch: number === 41 ? "main" : "feat/navigation", base: prSha(number - 1), additions: number === 41 ? 184 : 263, deletions: number === 41 ? 26 : 41,
    author: "jules", updatedAt: "2026-10-01T12:00:00.000Z", syncedAt: "2026-10-01T12:00:00.000Z",
    mergeState: "CLEAN", reviewDecision: "APPROVED", checks: { total: 12, passed: 12, pending: 0, failed: 0, complete: true },
    unresolvedReviews: 0, reviewsComplete: true, canUpdateBranch: true };
}
export function prStack(): PullRequestStack {
  return { id: "stack-one", number: 43, base: "main", layers: [41, 42].map((number) => ({ number,
    headBranch: prSnapshot(number).headBranch, head: prSha(number), state: "open", draft: false })) };
}
export function prLink(number = 42, repository = PR_REPOSITORY): LinkedPullRequest {
  return { ...prKey(number, repository), source: "manual", linkedAt: "2026-10-01T12:00:00.000Z", snapshot: prSnapshot(number), stack: prStack(), syncError: null };
}
