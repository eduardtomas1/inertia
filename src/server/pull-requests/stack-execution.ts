import type { StackOperation, StackReview } from "../../shared/pull-requests";
import type { PullRequestRepository } from "../persistence/pull-request-repository";
import { RuntimeRequestError } from "../runtime-errors";
import { publicRuntimeError } from "../runtime-errors";
import { GitHubResponseError } from "./github-transport";
import type { GitHubPullRequests, ObservedBranch } from "./github-client";
import type { MergeResponse } from "./github-schemas";
import { assertRebaseTopology, assertReviewedStack, prepareStackReview } from "./stack-review";

export function mergeOutcome(operation: StackOperation, response: MergeResponse, count: number, now: string): StackOperation {
  const state = response.status === "merged" ? "completed" : response.status === "failed" ? "failed" : "pending";
  return { ...operation, state, updatedAt: now, completedLayers: state === "completed" ? count : operation.completedLayers,
    message: state === "completed" ? "GitHub merged the reviewed stack layers."
      : state === "failed" ? "GitHub refused the stack merge. Check its branch rules and merge requirements."
        : response.status === "enqueued" ? "The stack is in GitHub's merge queue. Refresh to check its outcome."
          : "GitHub is merging the stack. Refresh to check its outcome." };
}
export async function executeStack(review: StackReview, repository: PullRequestRepository, client: GitHubPullRequests,
  assertOwner: () => void, now: () => number): Promise<void> {
  if (Date.parse(review.expiresAt) <= now()) throw new RuntimeRequestError("This stack review expired. Review the current stack again.");
  if (review.blockers.length) throw new RuntimeRequestError("Resolve the stack's blockers and review it again.");
  if (!repository.claim(review)) return;
  let operation: StackOperation = { id: review.id, key: review.key, stackNumber: review.stack.number, action: review.action,
    state: "running", completedLayers: 0, message: "Checking the reviewed stack on GitHub…", updatedAt: new Date(now()).toISOString() };
  let uncertain = false;
  const save = (): void => repository.settle(review.conversationId, operation);
  save();
  try {
    assertOwner();
    const current = await prepareStackReview(client, review.conversationId, review.key, review.action, now());
    assertReviewedStack(review, current);
    assertOwner();
    if (review.action === "merge") {
      const target = review.layers.find((layer) => layer.number === review.key.number)!;
      // Persist the claim before the request; an absent response never authorizes another PUT.
      uncertain = true;
      const response = await client.merge(review.key, target.snapshot.head);
      operation = mergeOutcome(operation, response, review.layers.length, new Date(now()).toISOString());
      repository.settle(review.conversationId, operation, response.details.uuid ?? null);
      return;
    }
    const processed: ObservedBranch[] = [];
    const heads = new Map<number, string>();
    for (const layer of review.layers) {
      assertOwner();
      assertRebaseTopology(review.stack, await client.stack(review.key), heads);
      const key = { ...review.key, number: layer.number };
      const branch = await client.branch(key, layer.snapshot.head, processed);
      const previous = processed.at(-1);
      // Earlier layers may have just changed this base. The bottom base must still be reviewed.
      if (branch.base !== (previous?.head ?? layer.snapshot.base)) throw new RuntimeRequestError("The base branch changed during the rebase. Refresh and review it again.");
      assertOwner();
      let head = branch.head;
      if (branch.behind > 0) {
        uncertain = true;
        head = await client.rebase(branch.id, branch.head);
        uncertain = false;
      }
      heads.set(layer.number, head);
      processed.push({ id: branch.id, number: layer.number, head });
      operation = { ...operation, completedLayers: processed.length, message: `Updated ${processed.length} of ${review.layers.length} stack layers.`, updatedAt: new Date(now()).toISOString() };
      save();
    }
    operation = { ...operation, state: "completed", message: "Every reviewed stack layer is up to date on GitHub.", updatedAt: new Date(now()).toISOString() };
    save();
  } catch (error) {
    // A definitive HTTP rejection cannot have accepted this mutation. Unknown transport/parse outcomes stay locked.
    const rejected = error instanceof GitHubResponseError && [400, 401, 403, 404, 405, 409, 422].includes(error.status);
    operation = { ...operation, state: uncertain && !rejected ? "unknown" : "failed", updatedAt: new Date(now()).toISOString(),
      message: uncertain && !rejected ? "GitHub did not confirm the outcome. Refresh or check GitHub before making further changes."
        : `${publicRuntimeError(error)}${operation.completedLayers ? ` ${operation.completedLayers} earlier layers remain updated on GitHub.` : ""}`.slice(0, 1000) };
    save();
  }
}
