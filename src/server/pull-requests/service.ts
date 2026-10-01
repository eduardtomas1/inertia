import type { RuntimeStore } from "../database";
import { RuntimeRequestError, publicRuntimeError } from "../runtime-errors";
import { parsePullRequestUrl, pullRequestIdentity, type LinkedPullRequest, type PullRequestKey, type PullRequestsResult, type StackReviewResult } from "../../shared/pull-requests";
import type { GitHubPullRequests } from "./github-client";
import { prepareStackReview } from "./stack-review";
import { rebaseIsNowComplete } from "./stack-reconciliation";
import { executeStack, mergeOutcome } from "./stack-execution";

export class PullRequestService {
  private readonly active = new Map<string, Promise<unknown>>();
  constructor(private readonly store: RuntimeStore, private readonly client: (signal: AbortSignal) => GitHubPullRequests,
    private readonly signal: AbortSignal, private readonly now = Date.now) { store.pullRequests.recover(); }
  get(conversationId: string): PullRequestsResult {
    this.store.conversation(conversationId);
    return { kind: "conversation.pull-requests", conversationId,
      links: this.store.pullRequests.list(conversationId).filter((link) => link.source !== "stack-dismissed"),
      operations: this.store.pullRequests.operations(conversationId) };
  }
  private assertOwner(conversationId: string): void {
    if (this.signal.aborted) throw new RuntimeRequestError("The local service is stopping. Check this action's outcome after it restarts.");
    if (this.store.conversation(conversationId).archivedAt) throw new RuntimeRequestError("Restore this chat before changing its pull requests.");
  }
  private async exclusive<T>(conversationId: string, operation: (client: GitHubPullRequests, signal: AbortSignal) => Promise<T>): Promise<T> {
    // Reads return the persisted cache while one owned remote operation is in progress.
    if (this.active.has(conversationId)) throw new RuntimeRequestError("A pull request action is already running in this chat.");
    this.assertOwner(conversationId);
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]);
    const pending = Promise.resolve().then(() => operation(this.client(signal), signal));
    this.active.set(conversationId, pending);
    try { return await pending; } finally { if (this.active.get(conversationId) === pending) this.active.delete(conversationId); }
  }
  async link(conversationId: string, url: string): Promise<PullRequestsResult> {
    const key = parsePullRequestUrl(url);
    if (!key) throw new RuntimeRequestError("Enter a GitHub pull request URL, such as https://github.com/owner/repo/pull/123.");
    return await this.exclusive(conversationId, async (client, signal) => {
      const previous = this.store.pullRequests.get(conversationId, key);
      this.store.pullRequests.save(conversationId, { ...key, source: "manual", linkedAt: previous?.linkedAt ?? new Date(this.now()).toISOString(),
        snapshot: previous?.snapshot ?? null, stack: previous?.stack ?? null, syncError: null });
      await this.sync(conversationId, client, signal, [key]);
      return this.get(conversationId);
    });
  }
  async unlink(conversationId: string, key: PullRequestKey): Promise<PullRequestsResult> {
    return await this.exclusive(conversationId, async () => {
      const ownsPendingLayer = this.store.pullRequests.operations(conversationId).some((operation) =>
        ["running", "pending", "unknown"].includes(operation.state)
        && operation.key.repository.toLowerCase() === key.repository.toLowerCase()
        && this.store.pullRequests.review(conversationId, operation.id)?.stack.layers.some((layer) => layer.number === key.number));
      if (ownsPendingLayer) throw new RuntimeRequestError("Check the pending GitHub stack action before unlinking this pull request.");
      this.store.pullRequests.unlink(conversationId, key);
      return this.get(conversationId);
    });
  }
  async refresh(conversationId: string): Promise<PullRequestsResult> {
    return await this.exclusive(conversationId, async (client, signal) => {
      await this.sync(conversationId, client, signal, this.get(conversationId).links);
      for (const operation of this.store.pullRequests.operations(conversationId)) {
        if (!["pending", "unknown"].includes(operation.state)) continue;
        const review = this.store.pullRequests.review(conversationId, operation.id);
        if (!review) continue;
        try {
          if (operation.action === "rebase") {
            if (await rebaseIsNowComplete(client, review)) this.store.pullRequests.settle(conversationId, { ...operation, state: "completed",
              completedLayers: review.layers.length, message: "GitHub now confirms every reviewed stack layer is up to date.", updatedAt: new Date(this.now()).toISOString() });
            continue;
          }
          const uuid = this.store.pullRequests.mergeUuid(operation.id);
          if (uuid) this.store.pullRequests.settle(conversationId, mergeOutcome(operation, await client.mergeStatus(operation.key, uuid), review.layers.length, new Date(this.now()).toISOString()));
          else {
            const current = await Promise.all(review.layers.map((layer) => client.read({ ...review.key, number: layer.number })));
            if (current.every((pr) => pr.state === "merged")) this.store.pullRequests.settle(conversationId, { ...operation, state: "completed",
              completedLayers: current.length, message: "GitHub confirms all reviewed stack layers are merged.", updatedAt: new Date(this.now()).toISOString() });
          }
        } catch { /* Retain the authoritative pending/unknown receipt; never re-submit. */ }
      }
      return this.get(conversationId);
    });
  }
  async prepare(conversationId: string, key: PullRequestKey, action: "merge" | "rebase"): Promise<StackReviewResult> {
    return await this.exclusive(conversationId, async (client) => {
      this.requireLink(conversationId, key);
      const review = await prepareStackReview(client, conversationId, key, action, this.now());
      this.assertOwner(conversationId);
      this.store.pullRequests.prepare(review);
      return { kind: "conversation.stack-review", review };
    });
  }
  async execute(conversationId: string, reviewId: string): Promise<PullRequestsResult> {
    return await this.exclusive(conversationId, async (client, signal) => {
      const review = this.store.pullRequests.review(conversationId, reviewId);
      if (!review) throw new RuntimeRequestError("This stack review is no longer available. Review the stack again.");
      this.requireLink(conversationId, review.key);
      await executeStack(review, this.store.pullRequests, client, () => { this.assertOwner(conversationId); this.requireLink(conversationId, review.key); }, this.now);
      try { await this.sync(conversationId, client, signal, this.get(conversationId).links); } catch { /* The durable action receipt remains available even if its cache refresh fails. */ }
      return this.get(conversationId);
    });
  }
  private requireLink(conversationId: string, key: PullRequestKey): LinkedPullRequest {
    const link = this.store.pullRequests.get(conversationId, key);
    if (!link || link.source === "stack-dismissed") throw new RuntimeRequestError("Link this pull request to the chat before changing its stack.");
    return link;
  }
  private async sync(conversationId: string, client: GitHubPullRequests, signal: AbortSignal, initial: PullRequestKey[]): Promise<void> {
    const queue = [...initial], visited = new Set<string>();
    for (const key of queue) {
      if (signal.aborted) break;
      const identity = pullRequestIdentity(key);
      if (visited.has(identity) || visited.size >= 200) continue;
      visited.add(identity);
      const existing = this.store.pullRequests.get(conversationId, key);
      if (existing?.source === "stack-dismissed") continue;
      const value: LinkedPullRequest = existing ?? { ...key, source: "stack", linkedAt: new Date(this.now()).toISOString(), snapshot: null, stack: null, syncError: null };
      try {
        const snapshot = await client.read(key);
        const stack = await client.stack(key);
        this.assertOwner(conversationId);
        this.store.pullRequests.save(conversationId, { ...value, snapshot, stack, syncError: null });
        for (const layer of stack?.layers ?? []) queue.push({ ...key, number: layer.number });
      } catch (error) {
        this.assertOwner(conversationId);
        if (existing) this.store.pullRequests.save(conversationId, { ...value, syncError: publicRuntimeError(error).slice(0, 1000) });
      }
    }
  }
}
