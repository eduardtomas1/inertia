import { describe, expect, it } from "vitest";

import {
  retainedDiffLock,
  type RetainedDiffLockInput,
} from "../../src/renderer/src/utils/retainedDiffLock";

const snapshot = { revision: 1 };
const laterSnapshot = { revision: 2 };
const identity = JSON.stringify(["project-a", "chat-a", ".", "README.md"]);

const validated: RetainedDiffLockInput = {
  snapshot,
  identity,
  repositoryReady: true,
  statusLoading: false,
  statusError: null,
  statusStale: false,
  diffLoading: false,
  diffError: null,
  validatedFor: { snapshot, identity },
};

describe("retained diff lock", () => {
  it("unlocks only a diff validated against the latest snapshot and selection with nothing in flight", () => {
    expect(retainedDiffLock(validated)).toBeNull();
  });

  it.each<[string, Partial<RetainedDiffLockInput>, ReturnType<typeof retainedDiffLock>]>([
    ["a status refresh is pending or hung", { statusLoading: true }, "refreshing"],
    ["a status refresh failed", { statusError: "Git inspection timed out." }, "failed"],
    ["a failed status refresh is being retried", { statusError: "Git inspection timed out.", statusLoading: true }, "failed"],
    ["a status refresh succeeded but the diff has not been reloaded", { snapshot: laterSnapshot }, "refreshing"],
    ["a diff load is pending or hung", { snapshot: laterSnapshot, diffLoading: true }, "refreshing"],
    ["a diff load is pending on the validated snapshot", { diffLoading: true }, "refreshing"],
    ["a diff load failed", { snapshot: laterSnapshot, diffError: "The diff could not be loaded." }, "failed"],
    ["the hook reported a Git error with a validated diff", { statusError: "Git changes could not be loaded." }, "failed"],
    ["an invalidation arrived before its refresh started", { statusStale: true }, "stale"],
    ["an invalidation arrived while offline and a diff load is pending", { statusStale: true, diffLoading: true }, "stale"],
    ["an invalidation's refresh is pending", { statusStale: true, statusLoading: true }, "refreshing"],
    ["the repository is not ready", { repositoryReady: false }, "stale"],
    ["there is no workspace snapshot", { snapshot: null }, "stale"],
    ["validation was cleared by a failed refresh", { validatedFor: null }, "stale"],
    ["the project, conversation, repository, or file changed", { identity: JSON.stringify(["project-b", "chat-a", ".", "README.md"]) }, "stale"],
    ["no file is selected", { identity: null }, "stale"],
    ["a passive background reload is pending", { snapshot: laterSnapshot, diffLoading: true }, "refreshing"],
  ])("locks when %s", (_name, change, expected) => {
    expect(retainedDiffLock({ ...validated, ...change })).toBe(expected);
  });

  it("unlocks again once a later snapshot is validated by a completed diff load", () => {
    expect(retainedDiffLock({
      ...validated,
      snapshot: laterSnapshot,
      validatedFor: { snapshot: laterSnapshot, identity },
    })).toBeNull();
  });
});
