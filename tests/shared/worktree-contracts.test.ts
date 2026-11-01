import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import type { WorktreeEntry } from "../../src/shared/worktrees";

const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST = "11111111-1111-4111-8111-111111111111";

const entry: WorktreeEntry = {
  path: "/data/worktrees/chat",
  location: "inertia",
  branch: "inertia/aaaaaaaa",
  head: "a".repeat(40),
  isMain: false,
  owned: true,
  conversationId: CONVERSATION,
  title: "Chat",
  chatStatus: "idle",
  sharedChatCount: 0,
  dirty: false,
  changeCount: 0,
  changeCountTruncated: false,
  ignoredFiles: false,
  locked: false,
  prunable: false,
  removal: { allowed: true },
};

describe("worktree command contracts", () => {
  it("accepts the three worktree commands", () => {
    for (const command of [
      { type: "worktree.list", requestId: REQUEST, payload: { projectId: PROJECT } },
      { type: "worktree.remove", requestId: REQUEST, payload: { projectId: PROJECT, path: "/data/worktrees/chat" } },
      { type: "worktree.prune", requestId: REQUEST, payload: { projectId: PROJECT } },
    ]) {
      expect(clientCommandSchema.safeParse(command).success).toBe(true);
    }
  });

  it("rejects malformed identities, extra fields and unsafe paths", () => {
    for (const command of [
      { type: "worktree.list", requestId: REQUEST, payload: { projectId: "nope" } },
      { type: "worktree.list", requestId: REQUEST, payload: { projectId: PROJECT, force: true } },
      { type: "worktree.prune", requestId: REQUEST, payload: {} },
      { type: "worktree.remove", requestId: REQUEST, payload: { projectId: PROJECT } },
      { type: "worktree.remove", requestId: REQUEST, payload: { projectId: PROJECT, path: "" } },
      { type: "worktree.remove", requestId: REQUEST, payload: { projectId: PROJECT, path: "/a\0b" } },
      { type: "worktree.remove", requestId: REQUEST, payload: { projectId: PROJECT, path: "/a\nb" } },
      { type: "worktree.remove", requestId: REQUEST, payload: { projectId: PROJECT, path: `/${"a".repeat(4_096)}` } },
      { type: "worktree.remove", requestId: REQUEST, payload: { projectId: PROJECT, path: "/a", force: true } },
    ]) {
      expect(clientCommandSchema.safeParse(command).success).toBe(false);
    }
  });
});

describe("worktree result contracts", () => {
  it("accepts list and action results at the server event boundary", () => {
    expect(() => parseServerEvent({
      type: "request.result",
      requestId: REQUEST,
      result: { kind: "worktree.list", list: { projectId: PROJECT, worktrees: [entry], truncated: false } },
    })).not.toThrow();
    expect(() => parseServerEvent({
      type: "request.result",
      requestId: REQUEST,
      result: {
        kind: "worktree.list",
        list: {
          projectId: PROJECT,
          truncated: false,
          worktrees: [{ ...entry, removal: { allowed: false, reason: "Another chat also uses this worktree, so it was kept." } }],
        },
      },
    })).not.toThrow();
    expect(() => parseServerEvent({
      type: "request.result",
      requestId: REQUEST,
      result: { kind: "worktree.action", outcome: { action: "prune", message: "Done.", branchDeleted: false } },
    })).not.toThrow();
    expect(() => parseServerEvent({
      type: "request.result",
      requestId: REQUEST,
      result: {
        kind: "worktree.action",
        outcome: { action: "remove", message: "Delete what is left by hand.", branchDeleted: false, partial: true },
      },
    })).not.toThrow();
  });

  it("rejects malformed results", () => {
    for (const result of [
      { kind: "worktree.list", list: { projectId: PROJECT, worktrees: [{ ...entry, removal: { allowed: false } }], truncated: false } },
      { kind: "worktree.list", list: { projectId: PROJECT, worktrees: [{ ...entry, location: "home" }], truncated: false } },
      { kind: "worktree.list", list: { projectId: PROJECT, worktrees: [{ ...entry, secret: "/home/other" }], truncated: false } },
      { kind: "worktree.action", outcome: { action: "delete", message: "x", branchDeleted: true } },
      { kind: "worktree.action", outcome: { action: "remove", message: "x", branchDeleted: true, partial: false } },
    ]) {
      expect(() => parseServerEvent({ type: "request.result", requestId: REQUEST, result })).toThrow();
    }
  });
});
