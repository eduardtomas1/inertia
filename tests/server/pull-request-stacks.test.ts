// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { PullRequestService } from "../../src/server/pull-requests/service";
import { GitHubResponseError } from "../../src/server/pull-requests/github-transport";
import type { GitHubPullRequests } from "../../src/server/pull-requests/github-client";
import { linkCreatedPullRequest } from "../../src/server/pull-requests/created-link";
import { parsePullRequestUrl, type PullRequestStack, type StackReview } from "../../src/shared/pull-requests";
import { prKey, prLink, prSha, prSnapshot, prStack } from "../support/pull-request-fixtures";

let store: RuntimeStore, directory: string, conversationId: string, service: PullRequestService;
let client: GitHubPullRequests, stack: PullRequestStack;
let now: number;
const prepare = async (action: "merge" | "rebase" = "merge") => (await service.prepare(conversationId, prKey(), action)).review;
const operation = () => store.pullRequests.operations(conversationId)[0]!;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "inertia-pr-stacks-"));
  store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  const project = store.createProject("Workspace", directory);
  conversationId = store.createConversation(project.id, "Related work").id;
  store.pullRequests.save(conversationId, prLink()); stack = prStack();
  now = Date.parse("2026-10-01T12:00:00Z");
  client = { read: vi.fn(async (key) => prSnapshot(key.number)), stack: vi.fn(async () => structuredClone(stack)),
    merge: vi.fn(async () => ({ status: "merged" as const, details: {} })), mergeStatus: vi.fn(async () => ({ status: "merged" as const, details: {} })),
    branch: vi.fn(async (key, head, processed) => ({ id: `PR_${key.number}`, head, base: processed.at(-1)?.head ?? prSnapshot(key.number).base, behind: 1 })),
    rebase: vi.fn(async (_id, head) => { const layer = stack.layers.find((entry) => entry.head === head)!; layer.head = prSha(layer.number + 100); return layer.head; }),
  };
  service = new PullRequestService(store, () => client, new AbortController().signal, () => now);
});
afterEach(() => { store.close(); rmSync(directory, { force: true, recursive: true }); });

describe("chat pull request collection", () => {
  it("keeps cross-repository identities distinct and persists them across restart", async () => {
    client.stack = vi.fn(async () => null);
    await service.link(conversationId, "https://github.com/ACME/docs/pull/42");
    expect(service.get(conversationId).links.map((link) => link.repository)).toEqual(["acme/workspace", "acme/docs"]);
    store.close(); store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
    expect(store.pullRequests.list(conversationId)).toHaveLength(2);
  });
  it("discovers native stack members but does not resurrect dismissed members", async () => {
    await service.refresh(conversationId);
    expect(service.get(conversationId).links.map((link) => [link.number, link.source])).toEqual([[42, "manual"], [41, "stack"]]);
    await service.unlink(conversationId, prKey(41));
    await service.refresh(conversationId);
    expect(service.get(conversationId).links.map((link) => link.number)).toEqual([42]);
    await service.link(conversationId, "https://github.com/acme/workspace/pull/41");
    expect(store.pullRequests.get(conversationId, prKey(41))?.source).toBe("manual");
  });
  it("retains last good details when refresh fails without leaking the remote error", async () => {
    client.read = vi.fn(async () => { throw new Error("raw provider output with secrets"); });
    const result = await service.refresh(conversationId);
    expect(result.links[0]).toMatchObject({ snapshot: prSnapshot(), stack: prStack(), syncError: "The request could not be completed." });
    expect(JSON.stringify(result)).not.toContain("secrets");
  });
  it("serializes refresh and unlink so late reads cannot recreate removed links", async () => {
    let done!: () => void; const wait = new Promise<void>((resolve) => { done = resolve; });
    client.read = vi.fn(async (key) => { await wait; return prSnapshot(key.number); });
    const refresh = service.refresh(conversationId);
    await expect(service.unlink(conversationId, prKey())).rejects.toThrow("already running");
    done(); await refresh; await service.unlink(conversationId, prKey());
    expect(service.get(conversationId).links.some((link) => link.number === 42)).toBe(false);
  });
  it("auto-links verified created URLs and retains a usable creation receipt on local failure", () => {
    expect(linkCreatedPullRequest(store, conversationId, "https://github.com/acme/docs/pull/7")).toBeUndefined();
    expect(store.pullRequests.get(conversationId, prKey(7, "acme/docs"))?.source).toBe("created");
    expect(linkCreatedPullRequest(store, randomUUID(), "https://github.com/acme/docs/pull/8")).toContain("was created");
  });
  it.each(["http://github.com/acme/repo/pull/1", "https://other.test/acme/repo/pull/1", "https://name@github.com/acme/repo/pull/1", "https://github.com/acme/repo/pull/1?q=token", "https://github.com/acme/repo/pull/9007199254740993", "https://github.com/acme/repo/pull/1/../../issues/2"])("refuses an untrusted PR identity: %s", (url) => {
    expect(parsePullRequestUrl(url)).toBeNull();
  });
});

describe("reviewed native stack actions", () => {
  it("merges the reviewed prefix once, including repeated execution requests", async () => {
    const review = await prepare();
    await Promise.all([service.execute(conversationId, review.id), service.execute(conversationId, review.id).catch(() => undefined)]);
    await service.execute(conversationId, review.id);
    expect(client.merge).toHaveBeenCalledExactlyOnceWith(prKey(), prSha(42));
    expect(operation()).toMatchObject({ state: "completed", completedLayers: 2 });
  });
  it("limits a lower-layer merge to its reviewed prefix", async () => {
    store.pullRequests.save(conversationId, prLink(41));
    const review = (await service.prepare(conversationId, prKey(41), "merge")).review;
    expect(review.layers.map((layer) => layer.number)).toEqual([41]);
    await service.execute(conversationId, review.id);
    expect(client.merge).toHaveBeenCalledExactlyOnceWith(prKey(41), prSha(41));
  });
  it.each(["head", "base", "order", "checks", "reviews"])("rejects changed %s after the user reviewed the stack", async (change) => {
    const review = await prepare();
    if (change === "order") stack.layers.reverse();
    if (change === "head") stack.layers[0]!.head = prSha(100);
    if (["base", "checks", "reviews"].includes(change)) client.read = vi.fn(async (key) => ({ ...prSnapshot(key.number),
      ...(change === "base" ? { base: prSha(99) } : change === "checks" ? { checks: { total: 12, passed: 11, pending: 1, failed: 0, complete: true } } : { unresolvedReviews: 1 }) }));
    await service.execute(conversationId, review.id);
    expect(client.merge).not.toHaveBeenCalled(); expect(operation().state).toBe("failed");
  });
  it.each(["draft", "checks", "reviews", "permission"])("presents %s blockers before confirmation", async (blocker) => {
    if (blocker === "draft") stack.layers[0]!.draft = true;
    client.read = vi.fn(async (key) => ({ ...prSnapshot(key.number), draft: blocker === "draft" && key.number === 41,
      ...(blocker === "checks" ? { checks: { total: 101, passed: 100, pending: 0, failed: 0, complete: false } } : {}),
      reviewsComplete: blocker !== "reviews", canUpdateBranch: blocker !== "permission" }));
    const review = await prepare(blocker === "permission" ? "rebase" : "merge");
    expect(review.blockers.length).toBeGreaterThan(0);
    await expect(service.execute(conversationId, review.id)).rejects.toThrow("blockers");
    expect(client.merge).not.toHaveBeenCalled(); expect(client.rebase).not.toHaveBeenCalled();
  });
  it("rejects expired, unlinked, archived and other-chat review receipts", async () => {
    let review = await prepare(); now += 300_001;
    await expect(service.execute(conversationId, review.id)).rejects.toThrow("expired");
    review = await prepare(); await service.unlink(conversationId, prKey());
    await expect(service.execute(conversationId, review.id)).rejects.toThrow("Link this");
    store.pullRequests.save(conversationId, prLink());
    const other = store.createConversation(store.conversation(conversationId).projectId, "Other chat").id;
    await expect(service.execute(other, review.id)).rejects.toThrow("no longer available");
    store.archiveConversation(conversationId, true);
    await expect(service.execute(conversationId, review.id)).rejects.toThrow("Restore");
  });
  it("retains a pending UUID across restart and polls it without re-submitting", async () => {
    client.merge = vi.fn(async () => ({ status: "pending" as const, details: { uuid: "merge-receipt" } }));
    const review = await prepare(); await service.execute(conversationId, review.id);
    expect(operation().state).toBe("pending");
    store.close(); store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
    service = new PullRequestService(store, () => client, new AbortController().signal, () => now);
    await service.refresh(conversationId);
    expect(client.mergeStatus).toHaveBeenCalledExactlyOnceWith(prKey(), "merge-receipt");
    expect(operation().state).toBe("completed"); expect(client.merge).toHaveBeenCalledOnce();
  });
  it("keeps enqueued merges pending until an authoritative status is available", async () => {
    client.merge = vi.fn(async () => ({ status: "enqueued" as const, details: {} }));
    const review = await prepare(); await service.execute(conversationId, review.id);
    await service.refresh(conversationId);
    expect(operation().state).toBe("pending"); expect(client.merge).toHaveBeenCalledOnce();
    client.read = vi.fn(async (key) => ({ ...prSnapshot(key.number), state: "merged" as const }));
    await service.refresh(conversationId); expect(operation().state).toBe("completed");
  });
  it("keeps an older pending action visible and reconciles it after newer history fills the limit", async () => {
    client.merge = vi.fn(async () => ({ status: "pending" as const, details: { uuid: "old-merge" } }));
    const pending = await prepare(); await service.execute(conversationId, pending.id);
    for (let number = 100; number < 122; number++) {
      const review = { ...pending, id: randomUUID(), key: prKey(number), stack: { ...pending.stack, number } };
      store.pullRequests.prepare(review); store.pullRequests.claim(review);
      store.pullRequests.settle(conversationId, { id: review.id, key: review.key, stackNumber: number, action: "merge",
        state: "completed", completedLayers: 2, message: "Merged", updatedAt: new Date(now).toISOString() });
    }
    expect(service.get(conversationId).operations).toHaveLength(20);
    expect(operation()).toMatchObject({ id: pending.id, state: "pending" });
    await service.refresh(conversationId);
    expect(client.mergeStatus).toHaveBeenCalledExactlyOnceWith(prKey(), "old-merge");
    expect(() => store.deleteConversation(conversationId)).not.toThrow();
    expect(client.merge).toHaveBeenCalledOnce();
  });
  it("cannot unlink a pending stack layer when fresh GitHub membership disappears", async () => {
    client.merge = vi.fn(async () => ({ status: "pending" as const, details: { uuid: "pending-merge" } }));
    client.mergeStatus = vi.fn(async () => ({ status: "pending" as const, details: { uuid: "pending-merge" } }));
    await service.execute(conversationId, (await prepare()).id);
    client.stack = vi.fn(async () => null);
    await service.refresh(conversationId);
    expect(service.get(conversationId).links.every((link) => link.stack === null)).toBe(true);
    await expect(service.unlink(conversationId, prKey(41))).rejects.toThrow("pending GitHub stack action");
    await expect(service.unlink(conversationId, prKey(42))).rejects.toThrow("pending GitHub stack action");
    expect(service.get(conversationId).links).toHaveLength(2);
    client.mergeStatus = vi.fn(async () => ({ status: "merged" as const, details: { uuid: "pending-merge" } }));
    await service.refresh(conversationId); await service.unlink(conversationId, prKey(41));
    expect(service.get(conversationId).links.map((link) => link.number)).toEqual([42]);
  });
  it("bounds outstanding actions without hiding their receipts or accepting another mutation", async () => {
    const template = await prepare();
    for (let number = 100; number < 120; number++) {
      const review = { ...template, id: randomUUID(), key: prKey(number), stack: { ...template.stack, number } };
      store.pullRequests.prepare(review); store.pullRequests.claim(review);
      store.pullRequests.settle(conversationId, { id: review.id, key: review.key, stackNumber: number, action: "merge",
        state: "unknown", completedLayers: 0, message: "Check GitHub", updatedAt: new Date(now).toISOString() });
    }
    await expect(service.execute(conversationId, (await prepare()).id)).rejects.toThrow("pending stack actions");
    expect(service.get(conversationId).operations).toHaveLength(20);
    expect(service.get(conversationId).operations.every(({ state }) => state === "unknown")).toBe(true);
    expect(client.merge).not.toHaveBeenCalled();
  });
  it("locks unknown outcomes across chats and does not lose the lock when deleting the owner", async () => {
    client.merge = vi.fn(async () => { throw new Error("socket closed after request"); });
    const review = await prepare(); await service.execute(conversationId, review.id);
    expect(operation().state).toBe("unknown");
    const other = store.createConversation(store.conversation(conversationId).projectId, "Other").id;
    store.pullRequests.save(other, prLink());
    const otherReview = (await service.prepare(other, prKey(), "merge")).review;
    await expect(service.execute(other, otherReview.id)).rejects.toThrow("outcome checked");
    expect(() => store.deleteConversation(conversationId)).toThrow("pending GitHub stack action");
    expect(client.merge).toHaveBeenCalledOnce();
  });
  it("allows a fresh review after a definitive remote rejection", async () => {
    client.merge = vi.fn(async () => { throw new GitHubResponseError(422); });
    const review = await prepare(); await service.execute(conversationId, review.id); expect(operation().state).toBe("failed");
    client.merge = vi.fn(async () => ({ status: "merged" as const, details: {} }));
    await service.execute(conversationId, (await prepare()).id); expect(operation().state).toBe("completed");
  });
  it("rebases bottom-to-top against expected heads and records updated bases", async () => {
    const review = await prepare("rebase"); await service.execute(conversationId, review.id);
    expect(client.rebase).toHaveBeenNthCalledWith(1, "PR_41", prSha(41));
    expect(client.rebase).toHaveBeenNthCalledWith(2, "PR_42", prSha(42));
    expect(client.branch).toHaveBeenNthCalledWith(2, prKey(42), prSha(42), expect.arrayContaining([{ id: "PR_41", number: 41, head: prSha(141) }]));
    expect(operation()).toMatchObject({ state: "completed", completedLayers: 2 });
  });
  it("retains partial progress and blocks retry after a lost rebase response", async () => {
    const original = client.rebase;
    client.rebase = vi.fn(async (id, head) => { if (id === "PR_42") throw new Error("lost response"); return await original(id, head); });
    const review = await prepare("rebase"); await service.execute(conversationId, review.id);
    expect(operation()).toMatchObject({ state: "unknown", completedLayers: 1 });
    store.pullRequests.recover(); expect(operation().completedLayers).toBe(1);
  });
  it("stops when an earlier layer is pushed during a rebase", async () => {
    const original = client.rebase;
    client.rebase = vi.fn(async (id, head) => { const updated = await original(id, head); stack.layers[0]!.head = prSha(999); return updated; });
    await service.execute(conversationId, (await prepare("rebase")).id);
    expect(client.rebase).toHaveBeenCalledOnce(); expect(operation()).toMatchObject({ state: "failed", completedLayers: 1 });
  });
  it("requires the top layer for a whole-stack rebase", async () => {
    store.pullRequests.save(conversationId, prLink(41));
    await expect(service.prepare(conversationId, prKey(41), "rebase")).rejects.toThrow("top pull request");
  });
  it("reconciles an unknown rebase only when GitHub proves every layer is now current", async () => {
    client.rebase = vi.fn(async () => { throw new Error("lost response"); });
    await service.execute(conversationId, (await prepare("rebase")).id);
    await service.refresh(conversationId); expect(operation().state).toBe("unknown");
    client.branch = vi.fn(async (key, head) => ({ id: `PR_${key.number}`, head, base: prSnapshot(key.number).base, behind: 0 }));
    await service.refresh(conversationId); expect(operation().state).toBe("completed");
    expect(client.rebase).toHaveBeenCalledOnce();
  });
  it("does not count dismissed stack members against the visible link limit", async () => {
    for (let number = 100; number < 301; number++) {
      store.pullRequests.save(conversationId, { ...prLink(number), source: "stack-dismissed" });
    }
    client.stack = vi.fn(async () => null);
    expect((await service.link(conversationId, "https://github.com/acme/docs/pull/1")).links).toHaveLength(2);
  });
  it("recovers an interrupted claimed action with its existing progress", async () => {
    const review: StackReview = await prepare("rebase"); store.pullRequests.claim(review);
    store.pullRequests.settle(conversationId, { id: review.id, key: review.key, stackNumber: review.stack.number,
      action: "rebase", state: "running", completedLayers: 1, message: "Updating", updatedAt: new Date(now).toISOString() });
    store.pullRequests.recover(); expect(operation()).toMatchObject({ state: "unknown", completedLayers: 1 });
  });
});
