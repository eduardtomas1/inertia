import type { RuntimeStore } from "../database";
import { parsePullRequestUrl } from "../../shared/pull-requests";

/** Creating on GitHub and persisting locally cannot share a transaction. Preserve the created URL on a local failure. */
export function linkCreatedPullRequest(store: RuntimeStore, conversationId: string | undefined, url: string): string | undefined {
  if (!conversationId) return undefined;
  try {
    store.conversation(conversationId);
    const key = parsePullRequestUrl(url);
    if (!key) throw new Error("Invalid created URL");
    const previous = store.pullRequests.get(conversationId, key);
    store.pullRequests.save(conversationId, { ...key, source: "created", linkedAt: previous?.linkedAt ?? new Date().toISOString(),
      snapshot: previous?.snapshot ?? null, stack: previous?.stack ?? null, syncError: null });
    return undefined;
  } catch {
    return "The pull request was created, but its link could not be saved to this chat. Keep this URL and link it from the Pull requests panel. Do not create it again.";
  }
}
