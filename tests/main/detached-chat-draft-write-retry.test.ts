import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  next: null as { path: string; afterCommit: boolean } | null,
}));
vi.mock("../../src/main/secure-atomic-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/secure-atomic-state")>();
  return {
    ...actual,
    writeSecureAtomicState(path: string, value: string, maximum: number): void {
      const fault = faults.next?.path === path ? faults.next : null;
      if (fault) faults.next = null;
      if (!fault || fault.afterCommit) actual.writeSecureAtomicState(path, value, maximum);
      if (fault) throw Object.assign(new Error("Synthetic sharing violation"), { code: "EBUSY" });
    },
  };
});

import { DetachedChatDraftStore, detachedChatDraftRecoveryPaths } from "../../src/main/detached-chat-draft-store";

const roots: string[] = [];
const conversationId = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
  faults.next = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-draft-write-retry-"));
  roots.push(directory);
  const path = join(directory, "drafts.json");
  const store = new DetachedChatDraftStore(path);
  store.put({ conversationId, draft: "Original draft" });
  return { store, paths: detachedChatDraftRecoveryPaths(path) };
}

it("retries a transient primary write only after verifying the unchanged stored state", () => {
  const { store, paths } = fixture();
  faults.next = { path: paths.target, afterCommit: false };
  expect(() => store.put({ conversationId, draft: "Retry this draft" })).toThrow("Synthetic");
  expect(store.snapshot()[0]?.draft).toBe("Original draft");
  const accepted = store.put({ conversationId, draft: "Retry this draft" });
  expect(new DetachedChatDraftStore(paths.target).snapshot()).toEqual([accepted]);
  expect(readFileSync(paths.target, "utf8")).toBe(readFileSync(paths.lastKnownGoodPath, "utf8"));
});

it.each([false, true])("repairs a transient recovery-copy write (commit already happened=%s)", (afterCommit) => {
  const { store, paths } = fixture();
  faults.next = { path: paths.lastKnownGoodPath, afterCommit };
  const accepted = store.put({ conversationId, draft: "Primary committed" });
  expect(store.snapshot()).toEqual([accepted]);
  expect(store.acknowledge({ conversationId, handoffId: accepted.handoffId })).toBe(true);
  expect(new DetachedChatDraftStore(paths.target).snapshot()).toEqual([]);
  expect(readFileSync(paths.target, "utf8")).toBe(readFileSync(paths.lastKnownGoodPath, "utf8"));
});

it("preserves an uncertain primary commit instead of overwriting it on retry", () => {
  const { store, paths } = fixture();
  faults.next = { path: paths.target, afterCommit: true };
  expect(() => store.put({ conversationId, draft: "Unacknowledged commit" })).toThrow("Synthetic");
  const primary = readFileSync(paths.target, "utf8");
  const backup = readFileSync(paths.lastKnownGoodPath, "utf8");
  expect(() => store.put({ conversationId, draft: "Must not overwrite" })).toThrow("unavailable");
  expect(readFileSync(paths.target, "utf8")).toBe(primary);
  expect(readFileSync(paths.lastKnownGoodPath, "utf8")).toBe(backup);
});

it("keeps externally changed backup evidence blocked after a transient write error", () => {
  const { store, paths } = fixture();
  faults.next = { path: paths.lastKnownGoodPath, afterCommit: false };
  store.put({ conversationId, draft: "Primary committed" });
  const replacement = JSON.stringify({ version: 1, drafts: [] });
  writeFileSync(paths.lastKnownGoodPath, replacement);
  const primary = readFileSync(paths.target, "utf8");
  expect(() => store.put({ conversationId, draft: "Must not overwrite" })).toThrow("unavailable");
  expect(readFileSync(paths.target, "utf8")).toBe(primary);
  expect(readFileSync(paths.lastKnownGoodPath, "utf8")).toBe(replacement);
});
