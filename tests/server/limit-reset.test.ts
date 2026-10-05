// @inertia-test-suite portable
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { LimitResetScheduler, type LimitResetDependencies } from "../../src/server/usage/limit-reset-scheduler";
import { resetQuota, resumeAccountIdentity } from "../../src/server/usage/limit-reset-policy";
import { NativeSubscriptionReader } from "../../src/server/usage/native-subscriptions";
import { queuedRouteIdentity } from "../../src/server/persistence/queued-message-repository";
import { providerUsageLimitsMigration } from "../../src/server/persistence/migrations/provider-usage-limits";
import { UsageLimitsRepository } from "../../src/server/persistence/usage-limits-repository";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";
import { UsageLimitsService } from "../../src/server/usage/limits-service";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import type { NativeUsageReader } from "../../src/server/usage/native";
import type { UsageAccount } from "../../src/shared/provider-usage-limits";
import { groupWorkThreads, sortActivityThreads } from "../../src/renderer/src/utils/sidebarModel";

const instant = Date.parse("2026-10-01T12:00:00.000Z");
const reset = new Date(instant + 60_000).toISOString();
const usage = (): UsageAccount => ({
  id: "native:codex", providerId: "codex", providerLabel: "Codex", label: "Codex account", email: "person@example.test",
  plan: "plus", identityKey: "verified-account-one", sources: ["This computer"], status: "ready", detail: null,
  updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), credits: null, canReset: false,
  windows: [{ id: "codex:primary", label: "5 hour", remainingPercent: 0, windowMinutes: 300, resetsAt: reset }],
});
let directory: string;
let store: RuntimeStore;
let abort: AbortController;
let conversationId: string;
let failedTurnId: string;
let account: UsageAccount;
let dependencies: LimitResetDependencies;
let scheduler: LimitResetScheduler;
function begin(limitResetPlanId?: string) {
  const conversation = store.conversation(conversationId);
  const run = store.createWorkspaceRun({ kind: "agent", projectId: conversation.projectId, conversationId,
    label: "Task", detail: null, status: "running", port: null });
  return store.beginAgentTurn({ conversationId, runId: run.id, content: "Continue", providerId: conversation.providerId,
    modelSelection: conversation.modelSelection, model: conversation.model || "gpt-test", reasoningEffort: conversation.reasoningEffort,
    interactionMode: conversation.interactionMode, accessMode: conversation.accessMode,
    configurationRevision: 0, association: "authoritative", limitResetPlanId }).turn;
}
function makeScheduler() {
  return new LimitResetScheduler(dependencies);
}
const schedule = (id = randomUUID()) => scheduler.schedule({ conversationId, id, failedTurnId, resetsAt: reset });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(instant);
  directory = mkdtempSync(join(tmpdir(), "inertia-reset-"));
  store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  const project = store.createProject("Project", directory);
  conversationId = store.createConversation(project.id, "Paused task", { model: "gpt-test" }).id;
  const turn = begin(); failedTurnId = turn.id;
  store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
  store.limitResets.markUsageLimited(turn.id);
  store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
  store.updateConversation(conversationId, { status: "failed" });
  abort = new AbortController(); account = usage();
  dependencies = { store, signal: abort.signal, enabled: true,
    readAccount: vi.fn(async () => ({ ...account, updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() })),
    cachedAccount: vi.fn(() => null),
    busy: () => false, dispatch: vi.fn(async (plan, guard) => { guard(); begin(plan.id); }),
    track: async (operation) => operation(), changed: vi.fn() };
  scheduler = makeScheduler();
});
afterEach(() => { abort.abort(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });

describe("quota reset actions", () => {
  it.each([
    ["codex", "gpt-test", "codex:primary"], ["claude", "claude-sonnet", "claude:five_hour"],
    ["cursor", "composer-2", "cursor:autoPercentUsed"], ["kimi", "kimi-code/k2", "kimi:weekly"],
    ["opencode", "opencode-go/model", "opencode:go_rolling"],
  ] as const)("schedules and admits one continuation for the native %s route", async (providerId, model, windowId) => {
    const projectId = store.conversation(conversationId).projectId;
    conversationId = store.createConversation(projectId, "Paused provider task", { providerId, model }).id;
    const turn = begin(); failedTurnId = turn.id;
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(turn.id);
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    account.providerId = providerId; account.windows[0]!.id = windowId;
    await schedule();
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)?.state).toBe("completed");
    expect(store.latestAgentTurnForConversation(conversationId)?.providerId).toBe(providerId);
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
  });

  it("persists explicit scheduling and claims its continuation atomically exactly once", async () => {
    const id = randomUUID();
    expect((await schedule(id)).plan).toMatchObject({ id, state: "waiting" });
    await schedule(id);
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
    const receipt = store.limitResets.get(conversationId)!;
    expect(receipt).toMatchObject({ id, state: "completed", turnId: expect.any(String) });
    expect(store.latestAgentTurnForConversation(conversationId)?.id).toBe(receipt.turnId);
    await scheduler.tick();
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
  });

  it("recovers an unaccepted dispatch after restart without replaying an accepted turn", async () => {
    const id = randomUUID(); await schedule(id);
    store.limitResets.claim(store.limitResets.get(conversationId)!);
    store.close(); store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
    dependencies.store = store; scheduler = makeScheduler(); scheduler.start();
    expect(store.limitResets.get(conversationId)?.state).toBe("waiting");
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)?.state).toBe("completed");
    store.close(); store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
    dependencies.store = store; scheduler = makeScheduler(); scheduler.start();
    await scheduler.tick(); expect(dependencies.dispatch).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "route", "archive", "settle", "new-turn"] as const)("rejects %s during asynchronous dispatch preparation", async (change) => {
    await schedule();
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    dependencies.dispatch = vi.fn(async (plan, guard) => {
      if (change === "cancel") scheduler.cancel(conversationId, plan.id);
      if (change === "route") store.updateConversation(conversationId, { accessMode: "full" });
      if (change === "archive") store.archiveConversation(conversationId, true);
      if (change === "settle") store.settleConversation(conversationId, true);
      if (change === "new-turn") begin();
      guard(); begin(plan.id);
    });
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)?.state).toBe(change === "cancel" ? "cancelled" : "blocked");
    expect(store.limitResets.get(conversationId)?.turnId).toBeNull();
    if (change !== "new-turn") expect(store.latestAgentTurnForConversation(conversationId)?.id).toBe(failedTurnId);
  });

  it.each([[59, "completed"], [61, "missed"]] as const)("handles a plan that can first run %i minutes after its reset", async (minutes, state) => {
    await schedule();
    vi.setSystemTime(Date.parse(reset) + minutes * 60_000); account.windows[0]!.remainingPercent = 100;
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)).toMatchObject({ state });
    expect(dependencies.dispatch).toHaveBeenCalledTimes(state === "completed" ? 1 : 0);
    expect(store.latestAgentTurnForConversation(conversationId)?.id === failedTurnId).toBe(state === "missed");
  });

  it("sends a missed plan only after an explicit Resume now", async () => {
    const id = randomUUID(); await schedule(id);
    vi.setSystemTime(Date.parse(reset) + 3 * 3_600_000); account.windows[0]!.remainingPercent = 100;
    await scheduler.tick(); await scheduler.tick();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    await expect(scheduler.resume({ conversationId, id: randomUUID() })).rejects.toThrow("no longer");
    expect((await scheduler.resume({ conversationId, id })).plan).toMatchObject({ id, state: "waiting" });
    await scheduler.tick();
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
    expect(store.limitResets.get(conversationId)).toMatchObject({ id, state: "completed" });
    await expect(scheduler.resume({ conversationId, id })).rejects.toThrow("no longer");
  });

  it("does not leave an unconfirmed dispatch to replay after restart", async () => {
    await schedule(); vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    dependencies.dispatch = vi.fn(async () => undefined);
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "blocked", turnId: null });
    store.close(); store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
    dependencies.store = store; scheduler = makeScheduler(); scheduler.start();
    await scheduler.tick();
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
  });

  it("does not offer or send a resume in a chat whose history mixes providers", async () => {
    const earlier = failedTurnId;
    vi.setSystemTime(instant + 1_000);
    const turn = begin(); failedTurnId = turn.id;
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(turn.id);
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    await schedule();
    const database = new Database(join(directory, "inertia.sqlite"));
    try { database.prepare("UPDATE agent_turns SET provider_id = 'claude' WHERE id = ?").run(earlier); } finally { database.close(); }
    expect((await scheduler.get(conversationId)).plan).toMatchObject({ state: "blocked" });
    expect((await scheduler.get(conversationId)).offer).toBeNull();
    await expect(schedule()).rejects.toThrow("limit changed");
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    await scheduler.tick();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });

  it("drops a pending resume with its deleted chat", async () => {
    await schedule();
    store.deleteConversation(conversationId);
    expect(store.limitResets.pending()).toEqual([]);
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    await scheduler.tick();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["blocked", "failed"], ["blocked", "completed"], ["missed", "failed"], ["missed", "completed"],
  ] as const)("retires a %s plan once a newer turn has %s", async (state, outcome) => {
    const id = randomUUID(); await schedule(id);
    store.limitResets.settle(store.limitResets.get(conversationId)!, state, state === "blocked" ? "The account changed." : null);
    vi.setSystemTime(instant + 5_000);
    const turn = begin();
    store.updateAgentTurnLifecycle(turn.id, { status: outcome, completedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(turn.id);
    store.updateWorkspaceRun(turn.runId, { status: outcome === "failed" ? "failed" : "succeeded", finishedAt: new Date().toISOString() });
    const result = await scheduler.get(conversationId);
    expect(store.limitResets.get(conversationId)).toMatchObject({ id, state: "cancelled" });
    expect(result.plan).toMatchObject({ id, state: "cancelled" });
    if (outcome === "failed") expect(result.offer).toMatchObject({ failedTurnId: turn.id, canResume: true });
    else expect(result.offer).toBeNull();
  });

  it("reads the account automatically only for a failure its provider tagged as usage-limited", async () => {
    vi.setSystemTime(instant + 1_000);
    const turn = begin(); failedTurnId = turn.id;
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    expect((await scheduler.get(conversationId)).offer).toBeNull();
    expect(dependencies.readAccount).not.toHaveBeenCalled();
    expect(dependencies.cachedAccount).toHaveBeenCalledOnce();
    vi.mocked(dependencies.cachedAccount).mockReturnValue({ ...account, updatedAt: new Date().toISOString() });
    expect((await scheduler.get(conversationId)).offer).toMatchObject({ failedTurnId, canResume: true });
    expect(dependencies.readAccount).not.toHaveBeenCalled();
    store.limitResets.markUsageLimited(turn.id);
    await scheduler.get(conversationId);
    expect(dependencies.readAccount).toHaveBeenCalledOnce();
    expect(vi.mocked(dependencies.readAccount).mock.calls[0]?.[1]).toBe(false);
  });

  it("backs off while a due plan cannot be updated and then marks it for attention", async () => {
    await schedule();
    vi.setSystemTime(Date.parse(reset) + 2 * 3_600_000);
    const settle = store.limitResets.settle.bind(store.limitResets);
    vi.spyOn(store.limitResets, "settle").mockImplementation((plan, state, error) => {
      if (state === "missed") throw new Error("SQLITE_FULL");
      settle(plan, state, error);
    });
    const track = vi.fn();
    dependencies.track = async (operation) => { track(); return operation(); };
    scheduler = makeScheduler(); scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(track.mock.calls.length).toBeLessThanOrEqual(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "blocked", error: expect.stringContaining("could not update") });
    const calls = track.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(track.mock.calls.length - calls).toBeLessThanOrEqual(1);
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });

  it("does not read the provider again for repeated schedule requests while a plan waits", async () => {
    await schedule();
    const reads = vi.mocked(dependencies.readAccount).mock.calls.length;
    for (let index = 0; index < 20; index += 1) await schedule();
    await Promise.all(Array.from({ length: 5 }, () => scheduler.snooze({ conversationId, failedTurnId, resetsAt: reset }).catch(() => undefined)));
    expect(vi.mocked(dependencies.readAccount).mock.calls.length - reads).toBe(1);
  });

  it("says whether the chat's latest failed turn hit a usage limit, with or without an offer", async () => {
    vi.mocked(dependencies.readAccount).mockResolvedValueOnce(null);
    expect(await scheduler.get(conversationId)).toMatchObject({ offer: null, plan: null, usageLimited: true });
    expect(await scheduler.get(conversationId)).toMatchObject({ offer: { failedTurnId }, usageLimited: true });
    await schedule();
    expect(await scheduler.get(conversationId)).toMatchObject({ plan: { state: "waiting" }, usageLimited: true });
    scheduler.cancel(conversationId, store.limitResets.get(conversationId)!.id);
    vi.setSystemTime(instant + 1_000);
    const turn = begin(); failedTurnId = turn.id;
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    expect(await scheduler.get(conversationId)).toMatchObject({ offer: null, usageLimited: false });
  });

  it("reports a pending plan from the database without another account read", async () => {
    await schedule();
    const reads = vi.mocked(dependencies.readAccount).mock.calls.length;
    vi.setSystemTime(instant + 61_000);
    expect((await scheduler.get(conversationId)).plan).toMatchObject({ state: "waiting" });
    expect(dependencies.readAccount).toHaveBeenCalledTimes(reads);
  });

  it("does not offer or schedule continuation after a failed chat is marked Done", async () => {
    store.settleConversation(conversationId, true);
    expect((await scheduler.get(conversationId)).offer).toBeNull();
    await expect(schedule()).rejects.toThrow("limit changed");
    expect(store.limitResets.get(conversationId)).toBeNull();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });

  it("rolls back the message and turn when cancellation wins the persistence race", async () => {
    await schedule(); const plan = store.limitResets.get(conversationId)!;
    store.limitResets.claim(plan); scheduler.cancel(conversationId, plan.id);
    expect(() => begin(plan.id)).toThrow("no longer owns");
    expect(store.latestAgentTurnForConversation(conversationId)?.id).toBe(failedTurnId);
    expect(store.conversationDetail(conversationId)!.messages).toHaveLength(1);
  });

  it("blocks an account switch and never sends against unknown or still exhausted quota", async () => {
    await schedule(); vi.setSystemTime(instant + 61_000);
    account.identityKey = "another-account"; account.windows[0]!.remainingPercent = 100;
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "blocked", error: expect.stringContaining("account") });
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });

  it("keeps checking with a capped backoff while the provider still reports the expired window, then offers Resume now", async () => {
    await schedule();
    vi.setSystemTime(Date.parse(reset) + 1_000);
    const checks: number[] = [];
    while (store.limitResets.get(conversationId)?.state === "waiting") {
      const due = Date.parse(store.limitResets.get(conversationId)!.nextAttemptAt);
      if (due > Date.now()) vi.setSystemTime(due);
      checks.push(Date.now() - Date.parse(reset));
      await scheduler.tick();
      expect(checks.length).toBeLessThan(30);
    }
    const gaps = checks.slice(1).map((at, index) => at - checks[index]!);
    expect(gaps.slice(0, 5)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(Math.max(...gaps)).toBe(300_000);
    expect(checks.at(-1)).toBeLessThanOrEqual(60 * 60_000);
    const missed = store.limitResets.get(conversationId)!;
    expect(missed).toMatchObject({ state: "missed", error: expect.stringContaining("nothing was sent") });
    expect(missed.error).not.toMatch(/refresh/i);
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    account.windows[0]!.remainingPercent = 100;
    expect((await scheduler.resume({ conversationId, id: missed.id })).plan).toMatchObject({ state: "waiting", error: null });
    await scheduler.tick();
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "completed" });
  });

  it("does not persist an unexpected dispatch error as public provider output", async () => {
    await schedule(); vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    dependencies.dispatch = vi.fn().mockRejectedValue(new Error("private provider diagnostics"));
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "blocked", error: "The request could not be completed." });
  });

  it("snoozes and acknowledges the failed run without authorizing a resume", async () => {
    await scheduler.snooze({ conversationId, failedTurnId, resetsAt: reset });
    expect(store.conversation(conversationId).snoozedUntil).toBe(reset);
    expect(store.limitResets.get(conversationId)).toBeNull();
    const view = sortActivityThreads([store.conversation(conversationId)], null, store.workspaceRunsForConversation(conversationId));
    expect(groupWorkThreads(view).find(({ id }) => id === "snoozed")?.threads).toHaveLength(1);
    vi.setSystemTime(instant + 61_000); await scheduler.tick();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });

  it("accepts bounded relative-reset sampling drift and persists the fresh provider time", async () => {
    const newer = new Date(Date.parse(reset) + 1000).toISOString();
    account.windows[0]!.resetsAt = newer;
    const id = randomUUID(); await schedule(id); await schedule(id);
    expect(store.limitResets.get(conversationId)).toMatchObject({ id, resetsAt: newer, nextAttemptAt: newer });
  });

  it("rejects stale reset times and routes changed before scheduling", async () => {
    const stale = new Date(instant + 120_000).toISOString();
    const changed = "The reported limit changed. Check the new reset time and try again.";
    await expect(scheduler.schedule({ conversationId, id: randomUUID(), failedTurnId, resetsAt: stale })).rejects.toThrow(changed);
    await expect(scheduler.snooze({ conversationId, failedTurnId, resetsAt: stale })).rejects.toThrow(changed);
    store.updateConversation(conversationId, { accessMode: "full" });
    expect((await scheduler.get(conversationId)).offer).toBeNull();
    await expect(schedule()).rejects.toThrow("limit changed");
  });

  it("retains waiting work across a temporary runtime admission refusal", async () => {
    await schedule(); vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    dependencies.track = vi.fn().mockRejectedValueOnce(new Error("Import in progress")).mockImplementation(async (operation) => operation());
    await scheduler.tick(); expect(store.limitResets.get(conversationId)?.state).toBe("waiting");
    await scheduler.tick(); expect(dependencies.dispatch).toHaveBeenCalledOnce();
  });
});

describe("resume account identity storage", () => {
  const secret = ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify({ sub: "cursor-account" })).toString("base64url"), "signature-0123456789"].join(".");
  function cursorChat(accountKey: () => Promise<string | null>) {
    const projectId = store.conversation(conversationId).projectId;
    conversationId = store.createConversation(projectId, "Paused Cursor task", { providerId: "cursor", model: "composer-2" }).id;
    const turn = begin(); failedTurnId = turn.id;
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(turn.id);
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    const reader = new NativeSubscriptionReader({ environment: async () => ({ CURSOR_AUTH_TOKEN: secret }), accountKey,
      fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ billingCycleEnd: Date.parse(reset),
        planUsage: { totalPercentUsed: 40, autoPercentUsed: 100, apiPercentUsed: 0 } }))) });
    dependencies.readAccount = (_providerId, _force, model, cwd) => reader.read({ ...usage(), id: "native:cursor", providerId: "cursor",
      providerLabel: "Cursor", email: null, identityKey: null, status: "unavailable", windows: [] }, model, abort.signal, cwd ?? directory);
  }
  it("stores neither a provider token nor its plain SHA-256 in the database", async () => {
    cursorChat(async () => "per-install-identity-key");
    await schedule();
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "waiting", accountIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    const contents = readdirSync(directory).filter((name) => name.startsWith("inertia.sqlite"))
      .map((name) => readFileSync(join(directory, name)).toString("latin1")).join("");
    for (const derivative of [secret, createHash("sha256").update(secret).digest("hex"),
      createHash("sha256").update("inertia-subscription\0cursor:subscription\0").update(secret).digest("hex")]) {
      expect(contents.includes(derivative), derivative).toBe(false);
    }
  });
  it("disables automatic resume when the per-install identity key is unavailable", async () => {
    cursorChat(async () => null);
    expect((await scheduler.get(conversationId)).offer).toMatchObject({ failedTurnId, canResume: false });
    await expect(schedule()).rejects.toThrow("limit changed");
  });
});

describe("macOS Keychain access", () => {
  let keychain: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  beforeEach(() => {
    const projectId = store.conversation(conversationId).projectId;
    conversationId = store.createConversation(projectId, "Paused Cursor task", { providerId: "cursor", model: "composer-2" }).id;
    const turn = begin(); failedTurnId = turn.id;
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(turn.id);
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    keychain = vi.fn(async () => "keychain-session-token");
    const reader = new NativeSubscriptionReader({ platform: "darwin", environment: async () => ({ HOME: directory }), readCursorKeychain: keychain,
      accountKey: async () => "per-install-identity-key",
      fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ billingCycleEnd: Date.parse(reset),
        planUsage: { totalPercentUsed: 40, autoPercentUsed: 100, apiPercentUsed: 0 } }))) });
    dependencies.readAccount = (_providerId, _force, model, cwd, interactive) => reader.read({ ...usage(), id: "native:cursor", providerId: "cursor",
      providerLabel: "Cursor", email: null, identityKey: null, status: "unavailable", windows: [] }, model, abort.signal, cwd ?? directory, interactive);
  });
  it("never reads the Keychain from the automatic chat refresh", async () => {
    expect(await scheduler.get(conversationId)).toMatchObject({ offer: null, plan: null });
    expect(keychain).not.toHaveBeenCalled();
    await scheduler.snooze({ conversationId, failedTurnId, resetsAt: reset });
    expect(keychain).toHaveBeenCalledOnce();
    expect(store.conversation(conversationId).snoozedUntil).toBe(reset);
  });
  it("accepts no client request for an explicit account read", () => {
    const command = { type: "conversation.limit-reset.get", requestId: randomUUID(), payload: { conversationId } };
    expect(clientCommandSchema.safeParse(command).success).toBe(true);
    expect(clientCommandSchema.safeParse({ ...command, payload: { conversationId, refresh: true } }).success).toBe(false);
  });
  it("never reads the Keychain from the scheduler", async () => {
    const route = queuedRouteIdentity(store.conversation(conversationId));
    store.limitResets.save({ id: randomUUID(), conversationId, failedTurnId, routeIdentity: route, accountIdentity: "a".repeat(64),
      resetsAt: reset, nextAttemptAt: reset, attempts: 0, state: "waiting", error: null, turnId: null });
    vi.setSystemTime(instant + 61_000);
    await scheduler.tick();
    expect(keychain).not.toHaveBeenCalled();
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "blocked" });
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });
});

describe("scheduler isolation", () => {
  const within = <T>(id: string, run: () => T): T => {
    const previous = conversationId;
    conversationId = id;
    try { return run(); } finally { conversationId = previous; }
  };
  function failedChat() {
    const projectId = store.conversation(conversationId).projectId;
    const id = store.createConversation(projectId, "Another paused task", { model: "gpt-test" }).id;
    const turn = within(id, () => begin());
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(turn.id);
    return { conversationId: id, failedTurnId: turn.id };
  }
  beforeEach(() => {
    dependencies.dispatch = vi.fn(async (plan, guard) => { guard(); within(plan.conversationId, () => begin(plan.id)); });
    scheduler = makeScheduler();
  });
  it("keeps plans waiting, without an attention state, while runtime admission keeps refusing", async () => {
    await schedule();
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    const refusals = vi.fn();
    dependencies.track = async () => { refusals(); throw new Error("Import in progress"); };
    scheduler = makeScheduler(); scheduler.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "waiting", error: null });
    expect(refusals.mock.calls.length).toBeLessThanOrEqual(6);
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    dependencies.track = async (operation) => operation();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "completed" });
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
  });
  it("keeps a healthy plan running while another plan's row cannot be updated", async () => {
    const healthy = failedChat();
    const broken = failedChat();
    await scheduler.schedule({ id: randomUUID(), ...healthy, resetsAt: reset });
    await scheduler.schedule({ id: randomUUID(), ...broken, resetsAt: reset });
    store.limitResets.save({ ...store.limitResets.get(broken.conversationId)!, nextAttemptAt: new Date(instant - 3 * 3_600_000).toISOString() });
    const settle = store.limitResets.settle.bind(store.limitResets);
    vi.spyOn(store.limitResets, "settle").mockImplementation((plan, state, error) => {
      if (plan.conversationId === broken.conversationId && state === "missed") throw new Error("row-specific failure");
      settle(plan, state, error);
    });
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.limitResets.get(healthy.conversationId)).toMatchObject({ state: "completed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.limitResets.get(broken.conversationId)).toMatchObject({ state: "blocked", error: expect.stringContaining("could not update") });
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
  });
  it("keeps exactly one continuation when a newer turn races the dispatch", async () => {
    await schedule();
    vi.setSystemTime(instant + 61_000); account.windows[0]!.remainingPercent = 100;
    dependencies.dispatch = vi.fn(async (plan, guard) => {
      await scheduler.get(plan.conversationId);
      expect(store.limitResets.get(plan.conversationId)?.state).toBe("dispatching");
      begin();
      await scheduler.get(plan.conversationId);
      guard(); begin(plan.id);
    });
    scheduler = makeScheduler();
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "cancelled", turnId: null });
  });
});

describe("cached reports for providers without a structured usage-limit signal", () => {
  it.each([
    ["cursor", "composer-2", "cursor:totalPercentUsed"],
    ["kimi", "kimi-code/k2", "kimi:weekly"],
    ["opencode", "opencode-go/m", "opencode:go_rolling"],
  ] as const)("offers %s after the Limits page reported its exhausted quota", async (providerId, model, windowId) => {
    const db = new Database(":memory:");
    db.exec(providerUsageLimitsMigration.up as string);
    const exhausted = { ...usage(), id: `native:${providerId}`, providerId, identityKey: null, email: null,
      windows: [{ id: windowId, label: "Window", remainingPercent: 0, windowMinutes: null, resetsAt: reset }] };
    const read = vi.fn<NativeUsageReader["read"]>(async () => ({ ...exhausted, credentialFingerprint: "f".repeat(64),
      updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() }));
    const info = { ...initialProviderSnapshots(false).find(({ id }) => id === providerId)!, available: true, canRun: true };
    const limits = new UsageLimitsService({ repository: new UsageLimitsRepository(db), native: { read, consume: vi.fn() },
      providers: () => [info], customProfiles: () => [], signal: abort.signal, enabled: true });
    dependencies.readAccount = (id, force, chatModel, cwd, interactive) => limits.nativeAccount(id, force, chatModel, cwd, interactive);
    dependencies.cachedAccount = (id, chatModel, cwd) => limits.cachedNativeAccount(id, chatModel, cwd);
    const projectId = store.conversation(conversationId).projectId;
    conversationId = store.createConversation(projectId, "Untagged failure", { providerId, model }).id;
    const turn = begin();
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    try {
      expect((await scheduler.get(conversationId)).offer).toBeNull();
      expect(read).not.toHaveBeenCalled();
      await limits.refresh(true);
      expect((await scheduler.get(conversationId)).offer).toMatchObject({ failedTurnId: turn.id, canResume: true });
      expect(read).toHaveBeenCalledOnce();
    } finally { db.close(); }
  });
});

describe("schema 87 usage-limit tags", () => {
  it("upgrades a schema-86 database and cascades tags with their chat", () => {
    const path = join(directory, "inertia.sqlite");
    store.close();
    const raw = new Database(path);
    raw.exec("DROP TABLE usage_limited_turns; DROP TABLE usage_limit_resume_plans; ALTER TABLE app_state DROP COLUMN quota_warnings_enabled; ALTER TABLE app_state DROP COLUMN quota_warning_threshold; ALTER TABLE app_state DROP COLUMN notify_only_in_background; DELETE FROM schema_migrations WHERE version >= 87;");
    for (const column of ["model", "activity", "usage_json", "tool_use_count", "duration_ms"]) {
      raw.exec(`ALTER TABLE subagent_traces DROP COLUMN ${column}`);
    }
    raw.exec("DROP INDEX workspace_runs_conversation_started_idx");
    raw.close();
    store = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
    dependencies.store = store;
    expect(store.limitResets.usageLimited(failedTurnId)).toBe(false);
    store.limitResets.markUsageLimited(failedTurnId);
    store.limitResets.markUsageLimited(failedTurnId);
    expect(store.limitResets.usageLimited(failedTurnId)).toBe(true);
    store.deleteConversation(conversationId);
    const check = new Database(path, { readonly: true });
    try {
      expect(check.prepare("SELECT count(*) AS n FROM usage_limited_turns").get()).toEqual({ n: 0 });
      expect(check.prepare("SELECT max(version) AS v FROM schema_migrations").get()).toEqual({ v: CURRENT_DATABASE_SCHEMA_VERSION });
    } finally { check.close(); }
  });
  it("cannot tag a turn that does not exist", () => {
    expect(() => store.limitResets.markUsageLimited(randomUUID())).toThrow(/FOREIGN KEY/u);
  });
});

describe("reported quota windows", () => {
  it.each([null, "invalid", "2026-10-01T12:00:01.000Z", "2026-10-01T11:56:59.000Z"])("rejects unknown, future, or stale account freshness: %s", (updatedAt) => {
    expect(resetQuota({ ...usage(), updatedAt }, "gpt-test")).toEqual({ kind: "unknown" });
  });
  it("uses the last exhausted reset and never invents a missing reset time", () => {
    const input = usage(); input.windows.push({ ...input.windows[0]!, id: "codex:secondary", resetsAt: new Date(instant + 7 * 86_400_000).toISOString() });
    expect(resetQuota(input, "gpt-test")).toEqual({ kind: "exhausted", resetsAt: input.windows[1]!.resetsAt });
    input.windows[1]!.resetsAt = null;
    expect(resetQuota(input, "gpt-test")).toEqual({ kind: "unknown" });
  });
  it("does not apply another Claude model's quota or guess an unknown model window", () => {
    const input = usage(); input.providerId = "claude";
    input.windows = [{ ...input.windows[0]!, id: "claude:five_hour", remainingPercent: 40 }, { ...input.windows[0]!, id: "claude:seven_day_opus" }];
    expect(resetQuota(input, "claude-sonnet-4-6")).toEqual({ kind: "available" });
    expect(resetQuota(input, "claude-opus-4-6").kind).toBe("exhausted");
    input.windows.push({ ...input.windows[0]!, id: "claude:model_0", remainingPercent: 0 });
    expect(resetQuota(input, "claude-sonnet-4-6")).toEqual({ kind: "unknown" });
  });
  it.each([NaN, Infinity, -Infinity, -1, 101])("never authorizes a resume from invalid remaining quota: %s", (remainingPercent) => {
    const input = usage(); input.windows[0]!.remainingPercent = remainingPercent;
    expect(resetQuota(input, "gpt-test").kind).toBe("unknown");
  });
  it("keeps reported account signatures separate from verified credit-redemption identities", async () => {
    const input = usage(); input.identityKey = null;
    expect(resumeAccountIdentity(input)).toBeNull();
    const reader = new NativeSubscriptionReader({ accountKey: async () => "per-install-identity-key" });
    const keyed = await reader.withMetadataIdentity(input, abort.signal);
    expect(keyed.credentialFingerprint).toBe(createHmac("sha256", "per-install-identity-key").update("inertia-subscription\0metadata:codex\0")
      .update(JSON.stringify(["codex", input.email, null, input.plan])).digest("hex"));
    expect(keyed.identityKey).toBeNull();
    expect(keyed.canReset).toBe(false);
    const claude = await reader.withMetadataIdentity({ ...input, providerId: "claude", organization: "Reported organization" }, abort.signal);
    const moved = await reader.withMetadataIdentity({ ...input, providerId: "claude", organization: "Another organization" }, abort.signal);
    expect(resumeAccountIdentity(claude)).not.toBe(resumeAccountIdentity(moved));
    const unkeyed = await new NativeSubscriptionReader({ accountKey: async () => null }).withMetadataIdentity(input, abort.signal);
    expect(resumeAccountIdentity(unkeyed)).toBeNull();
    expect(unkeyed.resumeUnavailable).toContain("Secure storage");
  });
});

describe("resume identity across credential renewal", () => {
  const jwt = (claims: Record<string, unknown>, nonce: string) => ["eyJhbGciOiJSUzI1NiJ9",
    Buffer.from(JSON.stringify({ ...claims, exp: 1_900_000_000, jti: nonce })).toString("base64url"), `signature-${nonce}`].join(".");
  let accessToken: string;
  beforeEach(() => {
    const projectId = store.conversation(conversationId).projectId;
    conversationId = store.createConversation(projectId, "Paused Kimi task", { providerId: "kimi", model: "k" }).id;
    const turn = begin(); failedTurnId = turn.id;
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(turn.id);
    store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    accessToken = jwt({ iss: "https://auth.kimi.com", sub: "account-one" }, "before");
    let remaining = "0";
    const config = `default_model = "k"\n[models.k]\nmodel = "k"\nprovider = "managed:kimi-code"\n[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "https://api.kimi.com/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/kimi-code"\n`;
    const reader = new NativeSubscriptionReader({ environment: async () => ({ KIMI_SHARE_DIR: "/k" }), accountKey: async () => "per-install-identity-key",
      readFile: async (path) => path.endsWith("config.toml") ? config : path.endsWith("kimi-code.json")
        ? JSON.stringify({ access_token: accessToken, expires_at: Date.now() / 1000 + 3600 }) : null,
      fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ usage: { limit: "100", remaining, resetAt: reset } }))) });
    dependencies.readAccount = (_providerId, _force, model, cwd) => {
      remaining = Date.now() >= Date.parse(reset) ? "100" : "0";
      return reader.read({ ...usage(), id: "native:kimi", providerId: "kimi", providerLabel: "Kimi",
        email: null, identityKey: null, status: "unavailable", windows: [] }, model, abort.signal, cwd ?? directory);
    };
  });
  it.each([["the same account", "account-one", "completed"], ["another account", "account-two", "blocked"]] as const)(
    "resumes only when a renewed OAuth token names %s", async (_label, sub, state) => {
      expect((await scheduler.get(conversationId)).offer).toMatchObject({ canResume: true, unavailableReason: null });
      await schedule();
      vi.setSystemTime(instant + 61_000);
      accessToken = jwt({ iss: "https://auth.kimi.com", sub }, "after");
      await scheduler.tick();
      expect(store.limitResets.get(conversationId)).toMatchObject({ state });
      expect(dependencies.dispatch).toHaveBeenCalledTimes(state === "completed" ? 1 : 0);
    });
  it("offers snooze only, with the reason, for a session token without a stable account claim", async () => {
    accessToken = "opaque-session-token-without-claims";
    const offer = (await scheduler.get(conversationId)).offer;
    expect(offer).toMatchObject({ failedTurnId, canResume: false, unavailableReason: expect.stringContaining("stable account") });
    await expect(schedule()).rejects.toThrow("limit changed");
  });
});
