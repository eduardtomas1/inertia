// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { LimitResetScheduler, type LimitResetDependencies } from "../../src/server/usage/limit-reset-scheduler";
import { resetQuota, resumeAccountIdentity } from "../../src/server/usage/limit-reset-policy";
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
  store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
  store.updateConversation(conversationId, { status: "failed" });
  abort = new AbortController(); account = usage();
  dependencies = { store, signal: abort.signal, enabled: true,
    readAccount: vi.fn(async () => ({ ...account, updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() })),
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

  it("bounds retries when the provider keeps reporting an expired exhausted window", async () => {
    await schedule();
    for (let attempt = 0; attempt < 3; attempt += 1) { vi.setSystemTime(instant + 61_000 + attempt * 31_000); await scheduler.tick(); }
    expect(store.limitResets.get(conversationId)).toMatchObject({ state: "blocked", attempts: 3 });
    expect(dependencies.dispatch).not.toHaveBeenCalled();
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
    await expect(scheduler.schedule({ conversationId, id: randomUUID(), failedTurnId, resetsAt: new Date(instant + 120_000).toISOString() })).rejects.toThrow("limit changed");
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
  it("keeps reported account signatures separate from verified credit-redemption identities", () => {
    const input = usage(); input.identityKey = null;
    expect(resumeAccountIdentity(input)).toMatch(/^[0-9a-f]{64}$/u);
    expect(input.identityKey).toBeNull();
    expect(input.canReset).toBe(false);
    input.providerId = "claude"; input.organization = "Reported organization";
    expect(resumeAccountIdentity(input)).toMatch(/^[0-9a-f]{64}$/u);
    const identity = resumeAccountIdentity(input); input.organization = "Another organization";
    expect(resumeAccountIdentity(input)).not.toBe(identity);
  });
});
