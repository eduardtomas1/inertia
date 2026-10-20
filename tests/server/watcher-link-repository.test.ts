import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { WatcherPolicyError, type WatcherLinkDraft } from "../../src/server/persistence/watcher-link-repository";
import type { Conversation } from "../../src/shared/contracts";
import { watcherFeedResultSchema } from "../../src/shared/contracts/watcher-schema";
import {
  providerNativeBackendProfile,
  providerNativeHarnessId,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import {
  DEFAULT_WATCHER_BUDGETS,
  DEFAULT_WATCHER_SHARING,
  MAX_ACTIVE_WATCHERS,
  MAX_WATCHER_LINKS_SERIALIZED_BYTES,
  MAX_WATCHER_PAUSE_DETAIL_CHARS,
  watcherLinksSerializedBytes,
  watcherLinkViewSchema,
  type WatcherNoteAttribution,
} from "../../src/shared/watcher";

let directory: string;
let databasePath: string;
let store: RuntimeStore;
let projectId: string;
let clock = Date.parse("2030-01-01T00:00:00.000Z");
const tick = () => new Date(clock += 1_000).toISOString();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "inertia-watcher-links-"));
  databasePath = join(directory, "inertia.sqlite");
  store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  projectId = store.createProject("Watcher project", directory).id;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function chat(title = "Main chat"): Conversation {
  return store.createConversation(projectId, title, {
    activate: false,
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
}

function draft(watchedConversationId: string, overrides: Partial<WatcherLinkDraft> = {}): WatcherLinkDraft {
  return {
    id: randomUUID(),
    watchedConversationId,
    preset: "reviewer",
    instructions: "Check the error handling.",
    sharing: { ...DEFAULT_WATCHER_SHARING },
    budgets: { ...DEFAULT_WATCHER_BUDGETS },
    privateConnect: "inherit",
    ...overrides,
  };
}

function attach(watched: Conversation, overrides: Partial<WatcherLinkDraft> = {}) {
  return store.watcherLinks.createWithConversation({
    link: draft(watched.id, overrides),
    conversation: {
      projectId: watched.projectId,
      title: `Watcher · Reviewer · ${watched.title}`,
      options: {
        interactionMode: "plan",
        accessMode: "supervised",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
      },
    },
  }, tick());
}

function beginTurn(conversation: Conversation, content = "Check now") {
  return store.beginAgentTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    runId: randomUUID(),
    content,
    activateConversation: false,
    providerId: conversation.providerId,
    harnessId: providerNativeHarnessId(conversation.providerId),
    backendProfileId: providerNativeBackendProfile(conversation.providerId).id,
    model: "provider-default",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode,
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt: tick(),
  }).turn;
}

function settleTurn(turnId: string) {
  const at = tick();
  store.settleAgentTurn(turnId, { status: "completed", terminalReason: "provider-completed", startedAt: at, completedAt: at, updatedAt: at });
}

/** Runs one complete check through the compare-and-set lifecycle. */
function check(linkId: string, outcome: "silent" | "finding" = "silent") {
  expect(store.watcherLinks.transition(linkId, ["watching"], { status: "waking" }, tick())).not.toBeNull();
  const wake = store.watcherLinks.createWake({
    id: randomUUID(), linkId, watchedTurnId: null, trigger: "activity",
    eventsCovered: 2, itemsTruncated: 0, itemsOmitted: 0, digestBytes: 512,
  }, tick());
  expect(wake).not.toBeNull();
  const settled = store.watcherLinks.settleWake(
    wake!.wakeId, outcome, { state: "clean", paths: [] },
    outcome === "finding" ? "The retry loop never backs off." : null, null, tick(),
  );
  expect(store.watcherLinks.transition(linkId, ["waking"], { status: "watching" }, tick())).not.toBeNull();
  return settled!;
}

function raw<T>(run: (database: Database.Database) => T): T {
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    return run(database);
  } finally {
    database.close();
  }
}

const conversationCount = () => store.shellSnapshot().conversations.length;

describe("watcher link repository", () => {
  it("creates the watcher chat, its title lock and the link atomically", () => {
    const watched = chat();
    const { link, conversation } = attach(watched);
    expect(conversation).toMatchObject({ projectId, interactionMode: "plan", accessMode: "supervised" });
    expect(store.conversationTitleLocked(conversation.id)).toBe(true);
    expect(link).toMatchObject({
      watcherConversationId: conversation.id, watchedConversationId: watched.id, projectId,
      status: "watching", counters: { wakeAllowance: 12, wakesThisTurn: 0 }, feedRevision: 0, latest: null,
    });
    expect(store.watcherLinks.findByWatcher(conversation.id)?.id).toBe(link.id);
    expect(store.watcherLinks.findActiveByWatched(watched.id)?.id).toBe(link.id);
    expect(store.watcherLinks.policyForConversation(conversation.id)).toEqual({ linkId: link.id, status: "watching" });
    expect(store.watcherLinks.policyForConversation(watched.id)).toBeNull();
    expect(store.watcherLinks.watchedAccess(conversation.id, watched.id)).toBe(true);
    expect(store.watcherLinks.watchedAccess(watched.id, conversation.id)).toBe(false);
    const views = store.shellSnapshot().watchers ?? [];
    expect(views).toHaveLength(1);
    expect(watcherLinkViewSchema.safeParse(views[0]).success).toBe(true);
    expect(views[0]).not.toHaveProperty("cursor");

    const before = conversationCount();
    expect(() => attach(watched)).toThrow("This chat already has a watcher.");
    expect(() => attach(conversation)).toThrow(WatcherPolicyError);
    const otherProject = store.createProject("Other", join(directory, "..")).id;
    const foreign = store.createConversation(otherProject, "Foreign chat", { activate: false });
    expect(() => store.watcherLinks.createWithConversation({
      link: draft(foreign.id),
      conversation: { projectId, title: "Watcher", options: {} },
    }, tick())).toThrow("A watcher must belong to the watched chat's project.");
    expect(() => attach(chat("Bad budgets"), { budgets: { ...DEFAULT_WATCHER_BUDGETS, digestKiB: 99 } })).toThrow();
    expect(conversationCount()).toBe(before + 2);
  });

  it("rolls the watcher chat back when the active-link limit trigger aborts", () => {
    const links = Array.from({ length: MAX_ACTIVE_WATCHERS }, (_, index) => attach(chat(`Chat ${index}`)).link);
    const watched = chat("One too many");
    const before = conversationCount();
    expect(() => attach(watched)).toThrow("watcher count limit exceeded");
    expect(conversationCount()).toBe(before);
    expect(store.watcherLinks.transition(links[0]!.id, ["watching"], { status: "detached", reason: "user" }, tick()))
      .toMatchObject({ status: "detached", detachedReason: "user" });
    expect(attach(watched).link.status).toBe("watching");
    expect(store.shellSnapshot().watchers).toHaveLength(MAX_ACTIVE_WATCHERS);
  });

  it("applies status transitions only from the expected states", () => {
    const { link } = attach(chat());
    const links = store.watcherLinks;
    expect(links.transition(link.id, ["paused"], { status: "watching" }, tick())).toBeNull();
    expect(links.transition(link.id, ["watching"], { status: "waking" }, tick())?.status).toBe("waking");
    expect(links.transition(link.id, ["watching"], { status: "waking" }, tick())).toBeNull();
    const paused = links.transition(link.id, ["waking"], { status: "paused", reason: "wake-budget", detail: "12 of 12 checks used\0" }, tick());
    expect(paused).toMatchObject({ status: "paused", pauseReason: "wake-budget", pauseDetail: "12 of 12 checks used" });
    const resumed = links.transition(link.id, ["paused"], { status: "watching" }, tick());
    expect(resumed).toMatchObject({ status: "watching", pauseReason: null, pauseDetail: null });
    expect(links.transition(link.id, ["watching", "paused"], { status: "detached", reason: "user" }, tick())?.status).toBe("detached");
    expect(links.transition(link.id, ["detached"], { status: "watching" }, tick())).toBeNull();
    expect(links.updateSettings(link.id, { preset: "explainer" }, tick())).toBeNull();
    expect(links.policyForConversation(link.watcherConversationId)?.status).toBe("detached");
    expect(links.watchedAccess(link.watcherConversationId, link.watchedConversationId!)).toBe(false);
    expect(() => raw((database) => database.prepare("UPDATE watcher_links SET status = 'watching', detached_reason = NULL WHERE id = ?").run(link.id)))
      .toThrow("A detached watcher cannot be attached again.");
    const attached = attach(chat("Second chat")).link;
    expect(() => raw((database) => database.prepare("UPDATE watcher_links SET status = 'paused' WHERE id = ?").run(attached.id)))
      .toThrow(/CHECK constraint failed/u);
    expect(() => raw((database) => database.prepare("UPDATE watcher_links SET watched_conversation_id = NULL WHERE id = ?").run(attached.id)))
      .toThrow(/CHECK constraint failed/u);
  });

  it("updates settings, follows watched turns and counts attempts per turn", () => {
    const { link } = attach(chat());
    const links = store.watcherLinks;
    expect(links.updateSettings(link.id, { preset: "scope-guard", budgets: { ...DEFAULT_WATCHER_BUDGETS, wakesPerWatchedTurn: 5 }, privateConnect: "hidden" }, tick()))
      .toMatchObject({ preset: "scope-guard", instructions: link.instructions, privateConnect: "hidden", budgets: { wakesPerWatchedTurn: 5 } });
    const started = links.beginWatchedTurn(link.id, "turn-1", tick());
    expect(started).toMatchObject({ watchedTurnId: "turn-1", counters: { wakeAllowance: 5, wakesThisTurn: 0 } });
    expect(links.recordAttempt(link.id, "write")).toBe(1);
    expect(links.recordAttempt(link.id, "write")).toBe(2);
    expect(links.recordAttempt(link.id, "command")).toBe(1);
    expect(links.beginWatchedTurn(link.id, "turn-1", tick())?.writeAttemptsThisTurn).toBe(2);
    const cursor = { turnId: "turn-1", activityAt: "2030-01-01T00:00:05.000Z", activityId: "activity-9", messageAt: null, pendingRunningIds: ["a", "a", "b"] };
    expect(links.notePendingEvents(link.id, 7, tick())?.counters.eventsPending).toBe(7);
    expect(links.notePendingEvents(link.id, 7, tick())).toBeNull();
    // The scheduler is the only source of the pending count: neither a check nor a new turn changes it.
    const advanced = links.advanceCursor(link.id, cursor, 4, tick());
    expect(advanced).toMatchObject({ cursor: { ...cursor, pendingRunningIds: ["a", "b"] }, counters: { eventsSeen: 4, eventsPending: 7 } });
    expect(links.grantWakes(link.id, 3)?.counters.wakeAllowance).toBe(8);
    expect(links.beginWatchedTurn(link.id, "turn-2", tick())).toMatchObject({
      writeAttemptsThisTurn: 0, commandAttemptsThisTurn: 0, counters: { wakeAllowance: 5, eventsPending: 7 },
      cursor: { turnId: "turn-2", activityAt: null, activityId: null, pendingRunningIds: [] },
    });
    expect(links.markQuiet(link.id, tick())?.quietSince).not.toBeNull();
    expect(links.markQuiet(link.id, tick())).toBeNull();
    links.recordWatchedOutput(link.id, tick());
    expect(links.get(link.id)?.quietSince).toBeNull();
    expect(links.markFinalPass(link.id, "turn-2", tick())).toBe(true);
    expect(links.markFinalPass(link.id, "turn-2", tick())).toBe(false);
  });

  it("moves the cursor only while it still follows the check's turn", () => {
    const { link } = attach(chat());
    const links = store.watcherLinks;
    const covered = (turnId: string) => ({ turnId, activityAt: "2030-01-01T00:00:05.000Z", activityId: "activity-1", messageAt: null, pendingRunningIds: [] });
    // A first check of a link that followed no turn yet takes the digest's turn.
    expect(links.advanceCursor(link.id, covered("turn-1"), 2, tick(), null)?.cursor).toEqual(covered("turn-1"));
    // The next turn begins while a check of turn-1 is still running; its late settlement must not rewind.
    links.beginWatchedTurn(link.id, "turn-2", tick());
    const late = links.advanceCursor(link.id, { ...covered("turn-1"), activityId: "activity-2" }, 3, tick(), "turn-1");
    expect(late).toMatchObject({
      watchedTurnId: "turn-2",
      cursor: { turnId: "turn-2", activityAt: null, activityId: null },
      counters: { eventsSeen: 5 },
    });
    expect(links.advanceCursor(link.id, covered("turn-2"), 1, tick(), "turn-2")?.cursor).toEqual(covered("turn-2"));
  });

  it("charges a check to the turn the link follows, never to the next turn", () => {
    const { link } = attach(chat());
    const links = store.watcherLinks;
    links.beginWatchedTurn(link.id, "turn-2", tick());
    const open = (watchedTurnId: string, trigger: "turn-end" | "activity") => {
      links.transition(link.id, ["watching"], { status: "waking" }, tick());
      const wake = links.createWake({ id: randomUUID(), linkId: link.id, watchedTurnId, trigger, eventsCovered: 0, itemsTruncated: 0, itemsOmitted: 0, digestBytes: 0 }, tick())!;
      links.settleWake(wake.wakeId, "silent", null, null, null, tick());
      links.transition(link.id, ["waking"], { status: "watching" }, tick());
    };
    open("turn-1", "turn-end");
    expect(links.get(link.id)?.counters).toMatchObject({ wakesThisTurn: 0, wakesTotal: 1 });
    open("turn-2", "activity");
    expect(links.get(link.id)?.counters).toMatchObject({ wakesThisTurn: 1, wakesTotal: 2 });
  });

  it("ends a wake-budget pause when the next watched turn starts, and only that pause", () => {
    const links = store.watcherLinks;
    const { link } = attach(chat("Budget"));
    links.beginWatchedTurn(link.id, "turn-1", tick());
    links.transition(link.id, ["watching"], { status: "paused", reason: "wake-budget", detail: "Used its checks." }, tick());
    expect(links.beginWatchedTurn(link.id, "turn-1", tick())).toMatchObject({ status: "paused", pauseReason: "wake-budget" });
    expect(links.beginWatchedTurn(link.id, "turn-2", tick())).toMatchObject({
      status: "watching", pauseReason: null, pauseDetail: null, counters: { wakeAllowance: 12, wakesThisTurn: 0 },
    });
    const user = attach(chat("User pause")).link;
    links.beginWatchedTurn(user.id, "turn-1", tick());
    links.transition(user.id, ["watching"], { status: "paused", reason: "user" }, tick());
    expect(links.beginWatchedTurn(user.id, "turn-2", tick())).toMatchObject({ status: "paused", pauseReason: "user" });
  });

  it("names the newest undismissed finding apart from the latest check", () => {
    const { link } = attach(chat());
    const links = store.watcherLinks;
    expect(links.get(link.id)?.latestFindingAt).toBeNull();
    const first = check(link.id, "finding");
    expect(links.get(link.id)?.latestFindingAt).toBe(first.settledAt);
    const quiet = check(link.id, "silent");
    expect(links.get(link.id)).toMatchObject({ latest: { outcome: "silent", at: quiet.settledAt }, latestFindingAt: first.settledAt });
    const second = check(link.id, "finding");
    links.setDelivery(second.wakeId, { mode: null, state: "dismissed" }, tick());
    expect(links.get(link.id)?.latestFindingAt).toBe(first.settledAt);
    links.setDelivery(first.wakeId, { mode: null, state: "dismissed" }, tick());
    expect(links.get(link.id)?.latestFindingAt).toBeNull();
    expect(watcherLinkViewSchema.safeParse(store.shellSnapshot().watchers?.[0]).success).toBe(true);
  });

  it("keeps eight maximal links under the snapshot cap and leaves instructions out of the shell", () => {
    const links = store.watcherLinks;
    expect(() => attach(chat("Bell"), { instructions: "ring\u0007" })).toThrow();
    const instructions = `${"界".repeat(1_000)}\n\t${"\"\\".repeat(499)}`;
    for (let index = 0; index < MAX_ACTIVE_WATCHERS; index += 1) {
      const { link } = attach(chat(`Chat ${index}`), { instructions, preset: "scope-guard" });
      check(link.id, "finding");
      raw((database) => database.prepare("UPDATE watcher_wakes SET finding_preview = ? WHERE link_id = ?")
        .run(`\u0001\u2028${"界".repeat(2_000)}`, link.id));
      const detail = `${"\u0007\n\u2028\uD800".repeat(100)}${"界".repeat(2_000)}`;
      expect(links.transition(link.id, ["watching"], { status: "paused", reason: "route-unavailable", detail }, tick())?.pauseDetail)
        .toHaveLength(MAX_WATCHER_PAUSE_DETAIL_CHARS);
      links.recordAttempt(link.id, "write");
    }
    const views = store.shellSnapshot().watchers ?? [];
    expect(views).toHaveLength(MAX_ACTIVE_WATCHERS);
    for (const view of views) {
      expect(watcherLinkViewSchema.safeParse(view).success).toBe(true);
      expect(view).not.toHaveProperty("instructions");
      expect(view.latest?.text).toHaveLength(200);
    }
    expect(watcherLinksSerializedBytes(views)).toBeLessThan(MAX_WATCHER_LINKS_SERIALIZED_BYTES);
    expect(links.get(views[0]!.id)?.instructions).toBe(instructions);
  });

  it("answers the shell's per-chat questions from single indexed rows", () => {
    const watched = chat();
    const { link, conversation } = attach(watched, { privateConnect: "hidden" });
    const links = store.watcherLinks;
    expect(links.parentForWatcher(conversation.id)).toEqual({ watchedConversationId: watched.id, privateConnect: "hidden" });
    expect(links.parentForWatcher(watched.id)).toBeNull();
    expect(links.watcherTurnActiveFor(watched.id)).toBe(false);
    const turn = beginTurn(conversation);
    expect(links.watcherTurnActiveFor(watched.id)).toBe(true);
    expect(links.watcherTurnActiveFor(conversation.id)).toBe(false);
    settleTurn(turn.id);
    expect(links.watcherTurnActiveFor(watched.id)).toBe(false);
    links.transition(link.id, ["watching"], { status: "detached", reason: "user" }, tick());
    expect(links.parentForWatcher(conversation.id)).toBeNull();
  });

  it("counts a watcher turn's settled commands without reading their details", () => {
    const watched = chat();
    const { conversation } = attach(watched);
    const turn = beginTurn(conversation);
    const other = beginTurn(conversation, "Second");
    raw((database) => {
      const insert = database.prepare(`
        INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2030-01-01T00:00:00.000Z')
      `);
      const add = (turnId: string, kind: string, status: string) => insert.run(randomUUID(), conversation.id, turn.runId, turnId, kind, "rg parser", "x".repeat(100_000), status);
      add(turn.id, "command", "completed");
      add(turn.id, "command", "failed");
      add(turn.id, "command", "running");
      add(turn.id, "tool", "completed");
      add(other.id, "command", "completed");
    });
    const counts = store.watcherLinks.digest.settledCommandCounts(conversation.id, [turn.id, other.id, "missing"]);
    expect(Object.fromEntries(counts)).toEqual({ [turn.id]: 2, [other.id]: 1 });
    expect(store.watcherLinks.digest.settledCommandCounts(watched.id, [turn.id]).size).toBe(0);
  });

  it("enforces the plan, supervised and harness locks only for attached watchers", () => {
    const watched = chat();
    const { link, conversation } = attach(watched);
    const links = store.watcherLinks;
    const allowed = { interactionMode: "plan" as const, accessMode: "supervised" as const, harnessId: "codex-app-server" };
    expect(() => links.assertRunConfigurationAllowed(conversation.id, allowed)).not.toThrow();
    expect(() => links.assertRunConfigurationAllowed(conversation.id, { ...allowed, interactionMode: "build" })).toThrow(WatcherPolicyError);
    expect(() => links.assertRunConfigurationAllowed(conversation.id, { ...allowed, accessMode: "full" })).toThrow(WatcherPolicyError);
    expect(() => links.assertRunConfigurationAllowed(conversation.id, { ...allowed, harnessId: "cursor-acp" })).toThrow(WatcherPolicyError);
    expect(() => links.assertRunConfigurationAllowed(watched.id, { ...allowed, accessMode: "full" })).not.toThrow();
    links.transition(link.id, ["watching"], { status: "detached", reason: "user" }, tick());
    expect(() => links.assertRunConfigurationAllowed(conversation.id, { ...allowed, interactionMode: "build" })).not.toThrow();
  });

  it("binds checks to the watcher chat's own turns and admits only dispatching claims", () => {
    const watched = chat();
    const { link, conversation } = attach(watched);
    const links = store.watcherLinks;
    expect(links.createWake({ id: randomUUID(), linkId: link.id, watchedTurnId: null, trigger: "manual", eventsCovered: 0, itemsTruncated: 0, itemsOmitted: 0, digestBytes: 0 }, tick()))
      .toBeNull();
    links.transition(link.id, ["watching"], { status: "waking" }, tick());
    const wake = links.createWake({ id: randomUUID(), linkId: link.id, watchedTurnId: "turn-9", trigger: "manual", eventsCovered: 3, itemsTruncated: 1, itemsOmitted: 2, digestBytes: 900, consumesAllowance: false }, tick())!;
    expect(wake).toMatchObject({ sequence: 1, state: "dispatching", watcherTurnId: null, eventsCovered: 3 });
    expect(links.get(link.id)).toMatchObject({ counters: { wakesThisTurn: 0, wakesTotal: 1 }, feedRevision: 1 });
    expect(links.createWake({ id: randomUUID(), linkId: link.id, watchedTurnId: null, trigger: "activity", eventsCovered: 0, itemsTruncated: 0, itemsOmitted: 0, digestBytes: 0 }, tick()))
      .toBeNull();
    expect(() => links.assertWakeTurnAllowed(conversation.id)).not.toThrow();
    expect(() => links.assertWakeTurnAllowed(conversation.id, wake.wakeId)).not.toThrow();
    expect(() => links.assertWakeTurnAllowed(watched.id, wake.wakeId)).toThrow(WatcherPolicyError);
    expect(() => links.assertWakeTurnAllowed(conversation.id, randomUUID())).toThrow(WatcherPolicyError);
    const foreignTurn = beginTurn(watched);
    expect(links.attachWakeTurn(wake.wakeId, foreignTurn.id, tick())).toBe(false);
    const turn = beginTurn(conversation);
    expect(links.attachWakeTurn(wake.wakeId, turn.id, tick())).toBe(true);
    expect(links.attachWakeTurn(wake.wakeId, turn.id, tick())).toBe(false);
    expect(() => links.assertWakeTurnAllowed(conversation.id, wake.wakeId)).toThrow(WatcherPolicyError);
    expect(links.wakeForTurn(turn.id)).toMatchObject({ wakeId: wake.wakeId, state: "running", linkId: link.id });
    const guardPaths = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`);
    const settled = links.settleWake(wake.wakeId, "finding", { state: "changed", paths: guardPaths }, "é".repeat(5_000), null, tick())!;
    expect(settled.guardPaths).toHaveLength(20);
    expect(Buffer.byteLength(settled.finding!, "utf8")).toBeLessThanOrEqual(8 * 1_024);
    expect(links.settleWake(wake.wakeId, "silent", null, null, null, tick())).toBeNull();
    expect(links.get(link.id)?.latest).toMatchObject({ outcome: "finding", text: "é".repeat(200) });
    settleTurn(turn.id);
    expect(store.conversationDetail(conversation.id)?.watcherWakes).toEqual([{
      wakeId: wake.wakeId, turnId: turn.id, sequence: 1, trigger: "manual", outcome: "finding",
      eventsCovered: 3, itemsTruncated: 1, itemsOmitted: 2, guardState: "changed",
    }]);
    expect(store.conversationHistory(conversation.id)?.watcherWakes).toHaveLength(1);
    expect(store.conversationDetail(watched.id)).not.toHaveProperty("watcherWakes");
    expect(links.wakeSummaries(conversation.id, [])).toEqual([]);
  });

  it("pages the feed newest first with a stable continuation", () => {
    const { link } = attach(chat());
    for (let index = 0; index < 25; index += 1) check(link.id, index % 5 === 0 ? "finding" : "silent");
    const first = store.watcherLinks.feed(link.id)!;
    expect(first.items.map(({ sequence }) => sequence)).toEqual(Array.from({ length: 20 }, (_, index) => 25 - index));
    expect(first.next).toEqual({ beforeSequence: 6 });
    expect(watcherFeedResultSchema.safeParse({ kind: "watcher.feed", ...first }).success).toBe(true);
    const second = store.watcherLinks.feed(link.id, first.next!.beforeSequence)!;
    expect(second.items.map(({ sequence }) => sequence)).toEqual([5, 4, 3, 2, 1]);
    expect(second.next).toBeNull();
    expect(second.feedRevision).toBe(first.feedRevision);
    expect(second.items[0]).not.toHaveProperty("deliveryId");
    expect(store.watcherLinks.feed(randomUUID())).toBeNull();
    expect(store.watcherLinks.get(link.id)?.counters.wakesTotal).toBe(25);
  });

  it("records user-initiated deliveries once and refuses non-findings", () => {
    const { link } = attach(chat());
    const silent = check(link.id, "silent");
    const finding = check(link.id, "finding");
    const links = store.watcherLinks;
    const deliveryId = randomUUID();
    expect(links.setDelivery(silent.wakeId, { mode: "queue", state: "queued", deliveryId }, tick())).toBeNull();
    expect(links.setDelivery(finding.wakeId, { mode: null, state: "queued" }, tick())).toBeNull();
    const queued = links.setDelivery(finding.wakeId, { mode: "queue", state: "queued", deliveryId, queuedMessageId: "queued-1" }, tick());
    expect(queued).toMatchObject({ deliveryId, queuedMessageId: "queued-1", delivery: { mode: "queue", state: "queued", detail: null } });
    expect(links.setDelivery(finding.wakeId, { mode: null, state: "dismissed" }, tick())).toBeNull();
    const sent = links.setDelivery(finding.wakeId, { mode: "queue", state: "sent", deliveredMessageId: "message-1" }, tick());
    expect(sent).toMatchObject({ deliveryId, queuedMessageId: "queued-1", deliveredMessageId: "message-1", delivery: { state: "sent" } });
    expect(links.setDelivery(finding.wakeId, { mode: "steer", state: "sent" }, tick())).toBeNull();
    const other = check(link.id, "finding");
    expect(links.setDelivery(other.wakeId, { mode: "steer", state: "failed", detail: "The turn ended." }, tick())?.delivery?.state).toBe("failed");
    expect(links.setDelivery(other.wakeId, { mode: null, state: "dismissed" }, tick())?.delivery).toMatchObject({ mode: null, state: "dismissed" });
  });

  it("keeps only the newest 500 checks per link", () => {
    const { link } = attach(chat());
    raw((database) => {
      const insert = database.prepare(`
        INSERT INTO watcher_wakes (id, link_id, sequence, trigger, state, outcome, created_at, settled_at)
        VALUES (?, ?, ?, 'activity', 'settled', 'silent', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')
      `);
      database.transaction(() => {
        for (let sequence = 1; sequence <= 502; sequence += 1) insert.run(randomUUID(), link.id, sequence);
      })();
      expect(database.prepare("SELECT COUNT(*) AS count, MIN(sequence) AS oldest FROM watcher_wakes WHERE link_id = ?").get(link.id))
        .toEqual({ count: 500, oldest: 3 });
    });
  });

  it("detaches links when the watched chat is deleted and keeps their history", () => {
    const watched = chat();
    const { link, conversation } = attach(watched);
    check(link.id, "finding");
    store.watcherLinks.transition(link.id, ["watching"], { status: "paused", reason: "user" }, tick());
    store.deleteConversation(watched.id);
    expect(store.watcherLinks.get(link.id)).toMatchObject({
      status: "detached", detachedReason: "watched-deleted", watchedConversationId: null, pauseReason: null,
    });
    expect(store.watcherLinks.feed(link.id)?.items).toHaveLength(1);
    expect(store.conversationShell(conversation.id)).not.toBeNull();
    expect(store.shellSnapshot().watchers).toEqual([]);
  });

  it("keeps a user detach reason when the watched chat is later deleted", () => {
    const watched = chat();
    const { link } = attach(watched);
    store.watcherLinks.transition(link.id, ["watching"], { status: "detached", reason: "user" }, tick());
    store.deleteConversation(watched.id);
    expect(store.watcherLinks.get(link.id)).toMatchObject({ detachedReason: "user", watchedConversationId: null });
  });

  it("refuses to delete a watched chat while its watcher has a turn running", () => {
    const watched = chat();
    const { link, conversation } = attach(watched);
    const turn = beginTurn(conversation);
    expect(() => store.deleteConversation(watched.id)).toThrow("Stop the watcher's current check before deleting this chat.");
    expect(store.conversationShell(watched.id)).not.toBeNull();
    expect(store.watcherLinks.get(link.id)?.status).toBe("watching");
    settleTurn(turn.id);
    expect(() => store.deleteConversation(watched.id)).not.toThrow();
    expect(store.watcherLinks.get(link.id)?.status).toBe("detached");
  });

  it("cascades the link and its checks when the watcher chat is deleted", () => {
    const watched = chat();
    const { link, conversation } = attach(watched);
    check(link.id);
    store.deleteConversation(conversation.id);
    expect(store.watcherLinks.get(link.id)).toBeNull();
    expect(store.watcherLinks.feed(link.id)).toBeNull();
    expect(raw((database) => database.prepare("SELECT COUNT(*) AS count FROM watcher_wakes").get())).toEqual({ count: 0 });
    expect(store.conversationShell(watched.id)).not.toBeNull();
    expect(attach(watched).link.status).toBe("watching");
  });

  it("removes links and checks with their project", () => {
    const watched = chat();
    const { link } = attach(watched);
    check(link.id, "finding");
    store.removeProject(projectId);
    expect(store.watcherLinks.get(link.id)).toBeNull();
    expect(raw((database) => database.prepare("SELECT COUNT(*) AS count FROM watcher_wakes").get())).toEqual({ count: 0 });
    expect(raw((database) => database.pragma("foreign_key_check"))).toEqual([]);
  });

  it("recovers interrupted checks after a restart", () => {
    const watched = chat();
    const { link, conversation } = attach(watched);
    store.watcherLinks.transition(link.id, ["watching"], { status: "waking" }, tick());
    const wake = store.watcherLinks.createWake({ id: randomUUID(), linkId: link.id, watchedTurnId: null, trigger: "activity", eventsCovered: 1, itemsTruncated: 0, itemsOmitted: 0, digestBytes: 10 }, tick())!;
    const turn = beginTurn(conversation);
    store.watcherLinks.attachWakeTurn(wake.wakeId, turn.id, tick());
    expect(store.watcherLinks.recoverInterruptedWakes(tick())).toEqual({ wakes: 0, links: 0 });
    settleTurn(turn.id);
    const revision = store.watcherLinks.get(link.id)!.feedRevision;
    expect(store.watcherLinks.recoverInterruptedWakes(tick())).toEqual({ wakes: 1, links: 1 });
    expect(store.watcherLinks.getWake(wake.wakeId)).toMatchObject({ state: "settled", outcome: "failed" });
    expect(store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", feedRevision: revision + 1 });
  });

  it("persists forwarded watcher notes on messages and queues them after user messages", () => {
    const watched = chat();
    const { link, conversation } = attach(watched);
    const note: WatcherNoteAttribution = {
      linkId: link.id, wakeId: randomUUID(), watcherConversationId: conversation.id,
      preset: "reviewer", watcherLabel: "Reviewer", delivery: "queue",
    };
    const message = store.createMessage(watched.id, "Forwarded note", "user", [], null, undefined, { watcherNote: note });
    expect(message.watcherNote).toEqual(note);
    expect(store.conversationDetail(watched.id)?.messages.find(({ id }) => id === message.id)?.watcherNote).toEqual(note);
    expect(() => store.createMessage(watched.id, "Bad", "assistant", [], null, undefined, { watcherNote: note })).toThrow("Invalid watcher note attribution.");
    expect(() => store.createMessage(watched.id, "Bad", "user", [], null, undefined, { watcherNote: { ...note, delivery: "auto" as "queue" } }))
      .toThrow("Invalid watcher note attribution.");
    const turn = beginTurn(watched, "Main work");
    const steered = store.createAcknowledgedFollowUpMessage(watched.id, turn.id, "Steered note", tick(), tick(), [], { watcherNote: { ...note, delivery: "steer" } });
    expect(store.conversationDetail(watched.id)?.messages.find(({ id }) => id === steered.id)?.watcherNote?.delivery).toBe("steer");
    const queue = (content: string, watcherNote?: WatcherNoteAttribution) => store.queuedMessages.add({
      id: randomUUID(), conversation: watched, content, attachments: [], digest: "a".repeat(64), ...(watcherNote ? { watcherNote } : {}),
    });
    const noteEntry = queue("Queued note", note);
    expect(noteEntry.watcherNote).toEqual(note);
    queue("First user message");
    queue("Second user message");
    expect(store.queuedMessages.list(watched.id).map(({ content }) => content))
      .toEqual(["First user message", "Second user message", "Queued note"]);
  });
});
