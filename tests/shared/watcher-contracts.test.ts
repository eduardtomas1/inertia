// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import {
  watcherDeliveryResultSchema,
  watcherFeedResultSchema,
  watcherLinkCollectionCoherent,
  watcherMutationEvent,
  watcherWakeSummariesCoherent,
} from "../../src/shared/contracts/watcher-schema";
import { STEERABLE_HARNESS_IDS, supportsActiveParentFollowUp } from "../../src/shared/follow-up-steer";
import { activityExecutionCategory } from "../../src/shared/activity-display";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { queuedMessageSchema } from "../../src/shared/queued-messages";
import {
  clampWatcherBudgets,
  DEFAULT_WATCHER_BUDGETS,
  DEFAULT_WATCHER_SHARING,
  MAX_ACTIVE_WATCHERS,
  WATCHER_HARNESS_IDS,
  WATCHER_PAUSE_REASONS,
  WATCHER_WAKE_OUTCOMES,
  watcherBudgetsSchema,
  watcherFeedItemSchema,
  watcherHarnessAllowed,
  watcherLinkViewSchema,
  watcherNoteAttributionSchema,
  type WatcherFeedItem,
  type WatcherLinkView,
} from "../../src/shared/watcher";

const at = "2030-01-01T00:00:00.000Z";
const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const projectId = uuid("1");
const watcherId = uuid("2");
const watchedId = uuid("3");
const link: WatcherLinkView = {
  id: uuid("4"),
  watcherConversationId: watcherId,
  watchedConversationId: watchedId,
  projectId,
  preset: "reviewer",
  instructions: "Focus on error handling.",
  sharing: { ...DEFAULT_WATCHER_SHARING },
  budgets: { ...DEFAULT_WATCHER_BUDGETS },
  privateConnect: "inherit",
  status: "watching",
  pauseReason: null,
  pauseDetail: null,
  detachedReason: null,
  watchedTurnId: "turn-1",
  counters: { wakesThisTurn: 1, wakeAllowance: 12, wakesTotal: 3, eventsSeen: 9, eventsPending: 2 },
  lastWakeAt: at,
  quietSince: null,
  feedRevision: 4,
  latest: { outcome: "silent", at, text: "" },
  createdAt: at,
  updatedAt: at,
};
const feedItem: WatcherFeedItem = {
  wakeId: uuid("5"),
  sequence: 3,
  watcherTurnId: "watcher-turn-3",
  watchedTurnId: "turn-1",
  trigger: "activity",
  outcome: "finding",
  state: "settled",
  eventsCovered: 4,
  itemsTruncated: 1,
  itemsOmitted: 0,
  guardState: "clean",
  guardPaths: [],
  finding: "The retry loop never backs off.",
  delivery: null,
  createdAt: at,
  settledAt: at,
};
const note = {
  linkId: link.id,
  wakeId: feedItem.wakeId,
  watcherConversationId: watcherId,
  preset: "reviewer",
  watcherLabel: "Reviewer model",
  delivery: "queue",
};

describe("watcher shared contracts", () => {
  it("gates watchers on the reviewed harness allowlist only", () => {
    expect(WATCHER_HARNESS_IDS).toEqual(["claude-agent-sdk", "codex-app-server", "opencode-sdk"]);
    for (const harnessId of WATCHER_HARNESS_IDS) expect(watcherHarnessAllowed(harnessId)).toBe(true);
    for (const harnessId of ["cursor-acp", "codex-cli", "kimi-cli", "", "CODEX-APP-SERVER"]) {
      expect(watcherHarnessAllowed(harnessId)).toBe(false);
    }
  });

  it("treats commands as governed by the provider gate, not as a pause reason", () => {
    expect(WATCHER_PAUSE_REASONS).not.toContain("command-attempts");
    expect(WATCHER_PAUSE_REASONS).toContain("write-attempts");
    expect(WATCHER_WAKE_OUTCOMES).toContain("command-attempt");
    expect(WATCHER_WAKE_OUTCOMES).toContain("write-attempt");
  });

  it("ships the documented budget defaults and clamps out-of-range values", () => {
    expect(DEFAULT_WATCHER_BUDGETS).toEqual({
      wakesPerWatchedTurn: 12, cooldownSeconds: 45, digestKiB: 24, contextReadsPerWake: 4,
    });
    expect(watcherBudgetsSchema.safeParse(DEFAULT_WATCHER_BUDGETS).success).toBe(true);
    expect(clampWatcherBudgets()).toEqual(DEFAULT_WATCHER_BUDGETS);
    expect(clampWatcherBudgets({
      wakesPerWatchedTurn: 1, cooldownSeconds: 10_000, digestKiB: 6.9, contextReadsPerWake: Number.NaN,
    })).toEqual({ wakesPerWatchedTurn: 2, cooldownSeconds: 600, digestKiB: 6, contextReadsPerWake: 4 });
    for (const invalid of [
      { ...DEFAULT_WATCHER_BUDGETS, wakesPerWatchedTurn: 41 },
      { ...DEFAULT_WATCHER_BUDGETS, cooldownSeconds: 14 },
      { ...DEFAULT_WATCHER_BUDGETS, digestKiB: 49 },
      { ...DEFAULT_WATCHER_BUDGETS, contextReadsPerWake: 9 },
      { ...DEFAULT_WATCHER_BUDGETS, contextReadsPerWake: 1.5 },
      { ...DEFAULT_WATCHER_BUDGETS, extra: 1 },
    ]) expect(watcherBudgetsSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps link views coherent with their status", () => {
    expect(watcherLinkViewSchema.safeParse(link).success).toBe(true);
    expect(watcherLinkViewSchema.safeParse({ ...link, status: "paused", pauseReason: "wake-budget", pauseDetail: "12 of 12" }).success).toBe(true);
    expect(watcherLinkViewSchema.safeParse({
      ...link, status: "detached", detachedReason: "watched-deleted", watchedConversationId: null,
    }).success).toBe(true);
    for (const invalid of [
      { ...link, status: "paused" },
      { ...link, pauseReason: "user" },
      { ...link, pauseReason: "command-attempts", status: "paused" },
      { ...link, pauseDetail: "not paused" },
      { ...link, status: "detached" },
      { ...link, detachedReason: "user" },
      { ...link, watchedConversationId: null },
      { ...link, watchedConversationId: watcherId },
      { ...link, instructions: "x".repeat(2_001) },
      { ...link, instructions: "nul\0byte" },
      { ...link, latest: { outcome: "finding", at, text: "x".repeat(201) } },
      { ...link, counters: { ...link.counters, eventsPending: -1 } },
      { ...link, filesystemPath: "/private" },
    ]) expect(watcherLinkViewSchema.safeParse(invalid).success).toBe(false);
  });

  it("bounds feed items and their delivery state", () => {
    expect(watcherFeedItemSchema.safeParse(feedItem).success).toBe(true);
    expect(watcherFeedItemSchema.safeParse({
      ...feedItem, delivery: { mode: "queue", state: "queued", detail: null, at },
    }).success).toBe(true);
    expect(watcherFeedItemSchema.safeParse({
      ...feedItem, delivery: { mode: null, state: "dismissed", detail: null, at },
    }).success).toBe(true);
    for (const invalid of [
      { ...feedItem, state: "running" },
      { ...feedItem, settledAt: null },
      { ...feedItem, finding: "€".repeat(2_800) },
      { ...feedItem, guardPaths: Array.from({ length: 21 }, (_, index) => `file-${index}`) },
      { ...feedItem, delivery: { mode: null, state: "queued", detail: null, at } },
      { ...feedItem, delivery: { mode: "steer", state: "dismissed", detail: null, at } },
      { ...feedItem, finding: null, delivery: { mode: "queue", state: "sent", detail: null, at } },
      { ...feedItem, sequence: 0 },
    ]) expect(watcherFeedItemSchema.safeParse(invalid).success).toBe(false);
  });

  it("carries an optional, bounded count of the read-only commands a check ran", () => {
    expect(watcherFeedItemSchema.parse({ ...feedItem, commandsRun: 3 }).commandsRun).toBe(3);
    expect(watcherFeedItemSchema.parse(feedItem)).not.toHaveProperty("commandsRun");
    for (const commandsRun of [0, -1, 1.5, 10_001, "2"]) {
      expect(watcherFeedItemSchema.safeParse({ ...feedItem, commandsRun }).success).toBe(false);
    }
  });

  it("accepts only bounded, single-line watcher note attribution", () => {
    expect(watcherNoteAttributionSchema.safeParse(note).success).toBe(true);
    for (const invalid of [
      { ...note, watcherLabel: "" },
      { ...note, watcherLabel: "x".repeat(81) },
      { ...note, watcherLabel: "two\nlines" },
      { ...note, delivery: "auto" },
      { ...note, linkId: "link-1" },
      { ...note, extra: true },
    ]) expect(watcherNoteAttributionSchema.safeParse(invalid).success).toBe(false);
    const queued = {
      id: uuid("6"), conversationId: watchedId, content: "Note", attachments: [], state: "waiting",
      createdAt: at, error: null, turnId: null, userMessageId: null,
    };
    expect(queuedMessageSchema.safeParse({ ...queued, watcherNote: note }).success).toBe(true);
    expect(queuedMessageSchema.safeParse({ ...queued, watcherNote: { ...note, preset: "auditor" } }).success).toBe(false);
  });

  it("validates the three watcher events and the three request results", () => {
    expect(watcherMutationEvent({ type: "watcher.link.updated", link })).toBe(true);
    expect(watcherMutationEvent({ type: "watcher.link.removed", linkId: link.id })).toBe(true);
    const live = {
      type: "watcher.live", linkId: link.id, watcherConversationId: watcherId, turnId: "watcher-turn-3",
      phase: "reading", label: "Reading src/index.ts", at,
    };
    expect(watcherMutationEvent(live)).toBe(true);
    expect(watcherMutationEvent({ ...live, label: null })).toBe(true);
    for (const invalid of [
      { ...live, phase: "editing" },
      { ...live, label: "x".repeat(121) },
      { ...live, label: "line\nbreak" },
      { type: "watcher.link.removed", linkId: "not-a-uuid" },
      { type: "watcher.link.updated", link: { ...link, status: "paused" } },
      { type: "watcher.unknown" },
      null,
    ]) expect(watcherMutationEvent(invalid)).toBe(false);

    const page = { kind: "watcher.feed", linkId: link.id, feedRevision: 4, items: [feedItem, { ...feedItem, wakeId: uuid("7"), sequence: 2 }], next: { beforeSequence: 2 } };
    expect(watcherFeedResultSchema.safeParse(page).success).toBe(true);
    expect(watcherFeedResultSchema.safeParse({ ...page, items: [], next: null }).success).toBe(true);
    for (const invalid of [
      { ...page, items: [...page.items].reverse() },
      { ...page, items: [feedItem, feedItem] },
      { ...page, next: { beforeSequence: 3 } },
      { ...page, items: [], next: { beforeSequence: 1 } },
      { ...page, items: Array.from({ length: 21 }, (_, index) => ({ ...feedItem, sequence: 30 - index })) },
    ]) expect(watcherFeedResultSchema.safeParse(invalid).success).toBe(false);
    const delivery = { kind: "watcher.delivery", linkId: link.id, wakeId: feedItem.wakeId, delivery: { mode: "steer", state: "sent", detail: null, at } };
    expect(watcherDeliveryResultSchema.safeParse(delivery).success).toBe(true);
    expect(watcherDeliveryResultSchema.safeParse({ ...delivery, delivery: null }).success).toBe(false);
  });

  it("requires coherent, unique link collections that share their chats' project", () => {
    const conversations = new Map([[watcherId, projectId], [watchedId, projectId]]);
    const projects = new Set([projectId]);
    expect(watcherLinkCollectionCoherent(undefined, conversations, projects)).toBe(true);
    expect(watcherLinkCollectionCoherent([link], conversations, projects)).toBe(true);
    expect(watcherLinkCollectionCoherent([link], new Map([[watchedId, projectId]]), projects)).toBe(true);
    const otherWatcher = uuid("8");
    const otherWatched = uuid("9");
    const second = { ...link, id: uuid("a"), watcherConversationId: otherWatcher, watchedConversationId: otherWatched };
    const all = new Map([...conversations, [otherWatcher, projectId], [otherWatched, projectId]]);
    expect(watcherLinkCollectionCoherent([link, second], all, projects)).toBe(true);
    for (const invalid of [
      [link, { ...link }],
      [link, { ...second, watchedConversationId: watchedId }],
      [link, { ...second, watchedConversationId: watcherId }],
      [link, { ...second, watcherConversationId: watcherId }],
      [{ ...link, projectId: uuid("b") }],
      [{ ...link, status: "unknown" }],
      { length: 0 },
    ]) expect(watcherLinkCollectionCoherent(invalid, all, projects)).toBe(false);
    expect(watcherLinkCollectionCoherent([link], new Map([[watcherId, uuid("b")], [watchedId, projectId]]), projects)).toBe(false);
    expect(watcherLinkCollectionCoherent([link], new Map(), projects)).toBe(false);
    const tooMany = Array.from({ length: MAX_ACTIVE_WATCHERS + 1 }, (_, index) => {
      const watcher = `${String(index).padStart(8, "0")}-0000-4000-8000-000000000001`;
      const watched = `${String(index).padStart(8, "0")}-0000-4000-8000-000000000002`;
      all.set(watcher, projectId).set(watched, projectId);
      return { ...link, id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000003`, watcherConversationId: watcher, watchedConversationId: watched };
    });
    expect(watcherLinkCollectionCoherent(tooMany.slice(0, MAX_ACTIVE_WATCHERS), all, projects)).toBe(true);
    expect(watcherLinkCollectionCoherent(tooMany, all, projects)).toBe(false);
  });

  it("binds wake summaries to the loaded turns of the watcher chat", () => {
    const summary = {
      wakeId: feedItem.wakeId, turnId: "watcher-turn-3", sequence: 3, trigger: "activity", outcome: "silent",
      eventsCovered: 9, itemsTruncated: 0, itemsOmitted: 0, guardState: "clean",
    };
    const turns = [{ id: "watcher-turn-3" }];
    expect(watcherWakeSummariesCoherent(undefined, turns)).toBe(true);
    expect(watcherWakeSummariesCoherent([summary], turns)).toBe(true);
    expect(watcherWakeSummariesCoherent([summary], [])).toBe(false);
    expect(watcherWakeSummariesCoherent([summary, { ...summary }], turns)).toBe(false);
    expect(watcherWakeSummariesCoherent([{ ...summary, outcome: "maybe" }], turns)).toBe(false);
  });

  it("registers every watcher command with strict payloads", () => {
    const requestId = uuid("c");
    const attach = {
      requestId,
      type: "watcher.attach",
      payload: {
        linkId: link.id, watchedConversationId: watchedId,
        modelSelection: providerNativeModelSelection({ providerId: "opencode", modelId: "provider-default" }),
        preset: "scope-guard", instructions: "", sharing: DEFAULT_WATCHER_SHARING, budgets: DEFAULT_WATCHER_BUDGETS,
        privateConnect: "hidden", initialReview: true,
      },
    };
    expect(clientCommandSchema.safeParse(attach).success).toBe(true);
    expect(clientCommandSchema.safeParse({ ...attach, payload: { ...attach.payload, instructions: "x".repeat(2_001) } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ ...attach, payload: { ...attach.payload, budgets: { digestKiB: 4 } } }).success).toBe(false);
    for (const type of ["watcher.pause", "watcher.resume", "watcher.wake", "watcher.detach"]) {
      expect(clientCommandSchema.safeParse({ requestId, type, payload: { linkId: link.id } }).success).toBe(true);
      expect(clientCommandSchema.safeParse({ requestId, type, payload: { linkId: link.id, confirm: true } }).success).toBe(false);
    }
    expect(clientCommandSchema.safeParse({ requestId, type: "watcher.update", payload: { linkId: link.id, preset: "explainer" } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ requestId, type: "watcher.update", payload: { linkId: link.id } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ requestId, type: "watcher.feed.get", payload: { linkId: link.id, beforeSequence: 5 } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ requestId, type: "watcher.feed.get", payload: { linkId: link.id, beforeSequence: 0 } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      requestId, type: "watcher.note.deliver",
      payload: { linkId: link.id, wakeId: feedItem.wakeId, mode: "steer", deliveryId: uuid("d") },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      requestId, type: "watcher.note.deliver", payload: { linkId: link.id, wakeId: feedItem.wakeId, mode: "steer" },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ requestId, type: "watcher.note.dismiss", payload: { linkId: link.id, wakeId: feedItem.wakeId } }).success).toBe(true);
  });

  it("shares the steerable harness list and activity categories across processes", () => {
    expect(STEERABLE_HARNESS_IDS).toEqual(["codex-app-server", "claude-agent-sdk", "opencode-sdk"]);
    expect(supportsActiveParentFollowUp("opencode-sdk")).toBe(true);
    expect(supportsActiveParentFollowUp("cursor-acp")).toBe(false);
    expect(supportsActiveParentFollowUp(null)).toBe(false);
    expect(activityExecutionCategory({ kind: "file", title: "src/a.ts", status: "running" })).toBe("coding");
    expect(activityExecutionCategory({ kind: "tool", title: "ApplyPatch", status: "running" })).toBe("coding");
    expect(activityExecutionCategory({ kind: "command", title: "rg", status: "running" })).toBe("command");
  });
});
