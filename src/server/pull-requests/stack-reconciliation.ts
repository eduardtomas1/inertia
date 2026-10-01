import type { StackReview } from "../../shared/pull-requests";
import type { GitHubPullRequests, ObservedBranch } from "./github-client";

/** Reconcile an unknown rebase by proving the whole reviewed topology is now up to date. Never retry a mutation. */
export async function rebaseIsNowComplete(client: GitHubPullRequests, review: StackReview): Promise<boolean> {
  const stack = await client.stack(review.key);
  if (!stack || stack.id !== review.stack.id || stack.number !== review.stack.number || stack.base !== review.stack.base
    || stack.layers.length !== review.stack.layers.length || stack.layers.some((layer, index) => {
      const previous = review.stack.layers[index]!;
      return layer.number !== previous.number || layer.headBranch !== previous.headBranch || layer.state !== previous.state;
    })) return false;
  const processed: ObservedBranch[] = [];
  for (const layer of review.layers) {
    const key = { ...review.key, number: layer.number };
    const current = await client.read(key);
    if (current.state !== "open" || stack.layers.find((entry) => entry.number === layer.number)?.head !== current.head) return false;
    const branch = await client.branch(key, current.head, processed);
    if (branch.behind !== 0 || branch.base !== (processed.at(-1)?.head ?? current.base)) return false;
    processed.push({ id: branch.id, number: layer.number, head: branch.head });
  }
  return JSON.stringify(stack) === JSON.stringify(await client.stack(review.key));
}
