import { randomUUID } from "node:crypto";
import type { PullRequestKey, PullRequestSnapshot, PullRequestStack, StackReview } from "../../shared/pull-requests";
import { RuntimeRequestError } from "../runtime-errors";
import type { GitHubPullRequests } from "./github-client";

export function affectedLayers(review: Pick<StackReview, "key" | "action" | "stack">) {
  const index = review.stack.layers.findIndex((layer) => layer.number === review.key.number);
  return (review.action === "merge" ? review.stack.layers.slice(0, index + 1) : review.stack.layers).filter((layer) => layer.state !== "merged");
}
export function mergeBlockers(number: number, pr: PullRequestSnapshot): string[] {
  const messages: string[] = [];
  if (pr.state !== "open") messages.push("is not open");
  if (pr.draft) messages.push("is a draft");
  if (pr.mergeState !== "CLEAN") messages.push(`is not ready to merge (${pr.mergeState.toLowerCase()})`);
  if (!pr.checks.complete) messages.push("has incomplete check information");
  if (pr.checks.pending || pr.checks.failed) messages.push("has pending or unsuccessful checks");
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") messages.push("still requires review");
  if (!pr.reviewsComplete || pr.unresolvedReviews) messages.push("has unresolved or incomplete review conversations");
  return messages.map((message) => `#${number} ${message}.`);
}
export async function prepareStackReview(client: GitHubPullRequests, conversationId: string, key: PullRequestKey,
  action: StackReview["action"], now: number): Promise<StackReview> {
  const stack = await client.stack(key);
  if (!stack) throw new RuntimeRequestError("This pull request is not in an available native GitHub stack.");
  const targetIndex = stack.layers.findIndex((layer) => layer.number === key.number);
  if (targetIndex < 0 || stack.layers[targetIndex]?.state !== "open") throw new RuntimeRequestError("Choose an open pull request in this stack.");
  if (action === "rebase" && targetIndex !== stack.layers.length - 1) throw new RuntimeRequestError("Select the top pull request to rebase the whole stack.");
  const layers: StackReview["layers"] = [];
  const blockers: string[] = [];
  for (const layer of affectedLayers({ stack, action, key })) {
    const snapshot = await client.read({ ...key, number: layer.number });
    if (layer.head === null || layer.head !== snapshot.head || layer.headBranch !== snapshot.headBranch || layer.state !== snapshot.state || layer.draft !== snapshot.draft) {
      throw new RuntimeRequestError("The stack changed while loading its review. Refresh and try again.");
    }
    layers.push({ number: layer.number, snapshot });
    if (action === "merge") blockers.push(...mergeBlockers(layer.number, snapshot));
    else {
      if (snapshot.state !== "open") blockers.push(`#${layer.number} is not open.`);
      if (!snapshot.canUpdateBranch) blockers.push(`You cannot update the branch for #${layer.number}.`);
    }
  }
  if (!layers.length) throw new RuntimeRequestError("This stack has no open layers to update.");
  return { id: randomUUID(), conversationId, key, action, stack, layers, blockers: blockers.length > 200 ? [...blockers.slice(0, 199), "Additional stack blockers remain. Resolve these and refresh."] : blockers,
    expiresAt: new Date(now + 5 * 60_000).toISOString() };
}
export function assertReviewedStack(expected: StackReview, current: StackReview): void {
  if (JSON.stringify(expected.stack) !== JSON.stringify(current.stack)
    || expected.layers.length !== current.layers.length
    || expected.layers.some((layer, index) => {
      const next = current.layers[index];
      return next?.number !== layer.number || next.snapshot.head !== layer.snapshot.head
        || next.snapshot.base !== layer.snapshot.base || next.snapshot.baseBranch !== layer.snapshot.baseBranch;
    })) throw new RuntimeRequestError("The stack or a reviewed revision changed. Review it again before continuing.");
  if (current.blockers.length) throw new RuntimeRequestError(current.blockers[0]!);
}
export function assertRebaseTopology(expected: PullRequestStack, current: PullRequestStack | null,
  heads: ReadonlyMap<number, string>): void {
  if (!current || current.id !== expected.id || current.number !== expected.number || current.base !== expected.base
    || current.layers.length !== expected.layers.length || expected.layers.some((layer, index) => {
      const next = current.layers[index];
      return !next || next.number !== layer.number || next.state !== layer.state || next.draft !== layer.draft
        || next.headBranch !== layer.headBranch || next.head !== (heads.get(layer.number) ?? layer.head);
    })) throw new RuntimeRequestError("The stack changed during the rebase. Earlier updates remain on GitHub; refresh before continuing.");
}
