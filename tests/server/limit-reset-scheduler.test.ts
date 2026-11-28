import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageAccount } from "../../src/shared/provider-usage-limits";
import { RuntimeStore } from "../../src/server/database";
import {
  LimitResetScheduler,
  type LimitResetDependencies,
  type LimitResetDispatchOptions,
} from "../../src/server/usage/limit-reset-scheduler";

const INSTANT = Date.parse("2026-10-01T12:00:00.000Z");
const RESET_AT = new Date(INSTANT + 60_000).toISOString();

function makeAccount(overrides: Partial<UsageAccount> = {}): UsageAccount {
  return {
    id: "native:codex",
    providerId: "codex",
    providerLabel: "Codex",
    label: "Codex account",
    email: "user@example.test",
    plan: "plus",
    identityKey: "verified-account",
    sources: ["This computer"],
    status: "ready",
    detail: null,
    updatedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    credits: null,
    canReset: false,
    windows: [{ id: "codex:primary", label: "5 hour", remainingPercent: 0, windowMinutes: 300, resetsAt: RESET_AT }],
    ...overrides,
  };
}

let directory: string;
let store: RuntimeStore;
let abort: AbortController;
let conversationId: string;
let failedTurnId: string;
let failedRunId: string;
let account: UsageAccount;
let dispatchCalls: Array<{ planId: string; options?: LimitResetDispatchOptions }>;
let dependencies: LimitResetDependencies;
let scheduler: LimitResetScheduler;

function beginTurn(targetConversationId: string, limitResetPlanId?: string) {
  const conversation = store.conversation(targetConversationId);
  const run = store.createWorkspaceRun({
    kind: "agent",
    projectId: conversation.projectId,
    conversationId: targetConversationId,
    label: "Task",
    detail: null,
    status: "running",
    port: null,
  });
  return store.beginOrchestratedAgentTurn({
    conversationId: targetConversationId,
    runId: run.id,
    content: "Continue",
    providerId: conversation.providerId,
    modelSelection: conversation.modelSelection,
    model: conversation.model || "gpt-test",
    reasoningEffort: conversation.reasoningEffort,
    interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode,
    configurationRevision: 0,
    association: "authoritative",
    limitResetPlanId,
  }).turn;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(INSTANT);
  directory = mkdtempSync(join(tmpdir(), "inertia-limit-reset-hardening-"));
  store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  const project = store.createProject("Hardening Project", directory);
  conversationId = store.createConversation(project.id, "Limited chat", { model: "gpt-test" }).id;
  const turn = beginTurn(conversationId);
  failedTurnId = turn.id;
  failedRunId = turn.runId;
  store.updateAgentTurnLifecycle(turn.id, { status: "failed", completedAt: new Date().toISOString() });
  store.limitResets.markUsageLimited(turn.id);
  store.updateWorkspaceRun(turn.runId, { status: "failed", finishedAt: new Date().toISOString() });
  store.updateConversation(conversationId, { status: "failed" });
  abort = new AbortController();
  account = makeAccount();
  dispatchCalls = [];
  dependencies = {
    store,
    signal: abort.signal,
    enabled: true,
    readAccount: vi.fn(async () => ({ ...account, updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() })),
    cachedAccount: vi.fn(() => null),
    busy: () => false,
    dispatch: vi.fn(async (plan, guard, options) => {
      dispatchCalls.push({ planId: plan.id, options });
      guard();
      beginTurn(plan.conversationId, plan.id);
    }),
    track: async (op) => op(),
    changed: vi.fn(),
  };
  scheduler = new LimitResetScheduler(dependencies);
});

afterEach(() => {
  abort.abort();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("D.6 usage-limit hardening (LimitResetScheduler)", () => {
  it("uses a fresh requestId on restart-safe unsent resume and records scheduled/limit-reset attribution", async () => {
    const planId = randomUUID();
    await scheduler.schedule({ conversationId, id: planId, failedTurnId, resetsAt: RESET_AT });

    // First attempt crashes mid-dispatch (aborted before turn commits -> stays unsent).
    let firstRequestId: string | undefined;
    dependencies.dispatch = vi.fn(async (_plan, _guard, options) => {
      firstRequestId = options?.requestId;
      expect(options).toMatchObject({ attribution: "limit-reset", origin: "scheduled" });
      abort.abort();
      throw new Error("Simulated restart abort");
    });
    vi.setSystemTime(INSTANT + 61_000);
    account.windows[0]!.remainingPercent = 100;
    await scheduler.tick();
    expect(firstRequestId).toBeTruthy();

    // Reopen store and scheduler as after restart (reconcile returns unsent plan to waiting).
    store.close();
    store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
    abort = new AbortController();
    let secondRequestId: string | undefined;
    dependencies = {
      ...dependencies,
      store,
      signal: abort.signal,
      dispatch: vi.fn(async (plan, guard, options) => {
        secondRequestId = options?.requestId;
        expect(options).toMatchObject({ attribution: "limit-reset", origin: "scheduled" });
        guard();
        beginTurn(plan.conversationId, plan.id);
      }),
    };
    scheduler = new LimitResetScheduler(dependencies);
    scheduler.start();
    await scheduler.tick();

    expect(secondRequestId).toBeTruthy();
    expect(secondRequestId).not.toBe(firstRequestId);
    expect(secondRequestId).not.toBe(planId);
    expect(store.limitResets.get(conversationId)?.state).toBe("completed");
  });

  it("refuses fresh arming when resetsAt is more than 24 hours overdue", async () => {
    const overdueReset = new Date(INSTANT - 25 * 60 * 60 * 1_000).toISOString();
    await expect(scheduler.schedule({
      conversationId,
      id: randomUUID(),
      failedTurnId,
      resetsAt: overdueReset,
    })).rejects.toThrow("more than 24 hours old");
    expect(store.limitResets.get(conversationId)).toBeNull();
  });

  it("enforces stop-beats-arming: refuses arming and cancels pending plans when the user stopped the chat", async () => {
    const planId = randomUUID();
    await scheduler.schedule({ conversationId, id: planId, failedTurnId, resetsAt: RESET_AT });
    expect(store.limitResets.get(conversationId)?.state).toBe("waiting");

    // Record a user run-interrupt on the failed turn's run.
    const target = store.orchestration.runControl.target(failedRunId)!;
    // Mark run non-terminal in a fresh conversation turn to test via recordInterrupt cleanly:
    const project = store.project(store.conversation(conversationId).projectId);
    const stoppedChat = store.createConversation(project.id, "Stopped chat", { model: "gpt-test" });
    const stoppedTurn = beginTurn(stoppedChat.id);
    const stopTarget = store.orchestration.runControl.target(stoppedTurn.runId)!;
    const stopStart = await store.orchestration.authority.begin({
      source: { actorId: "human", commandId: randomUUID(), command: { type: "agent.stop" } },
      threadId: stoppedChat.id,
      projectId: project.id,
      commandType: "agent.stop",
      rejection: null,
    }, (ticket) => {
      store.orchestration.runControl.recordInterrupt(ticket, stopTarget, stoppedTurn.id, "user");
    });
    if (stopStart.kind === "lead") stopStart.ticket.finish(null);
    store.updateAgentTurnLifecycle(stoppedTurn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(stoppedTurn.id);
    store.updateWorkspaceRun(stoppedTurn.runId, { status: "failed", finishedAt: new Date().toISOString() });

    await expect(scheduler.schedule({
      conversationId: stoppedChat.id,
      id: randomUUID(),
      failedTurnId: stoppedTurn.id,
      resetsAt: RESET_AT,
    })).rejects.toThrow("stopped");
    expect((await scheduler.get(stoppedChat.id)).offer).toBeNull();

    // Also verify an already-armed pending plan is cancelled on tick() when a user stop lands.
    expect(target).not.toBeNull();
    (store as unknown as { database: { prepare(sql: string): { run(...args: unknown[]): unknown } } })
      .database.prepare("UPDATE agent_turns SET terminal_reason = 'user-cancelled' WHERE id = ?")
      .run(failedTurnId);
    vi.setSystemTime(INSTANT + 61_000);
    account.windows[0]!.remainingPercent = 100;
    await scheduler.tick();
    expect(store.limitResets.get(conversationId)?.state).toBe("cancelled");
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });

  it("refuses arming on archived conversations or delegated children whose parent is archived or deleted", async () => {
    const projectId = store.conversation(conversationId).projectId;

    // Archived conversation itself.
    store.archiveConversation(conversationId, true);
    await expect(scheduler.schedule({
      conversationId,
      id: randomUUID(),
      failedTurnId,
      resetsAt: RESET_AT,
    })).rejects.toThrow("Archived or deleted");
    store.archiveConversation(conversationId, false);

    // Delegated child whose parent is archived.
    const parent = store.createConversation(projectId, "Parent chat", { model: "gpt-test" });
    const parentTurn = beginTurn(parent.id);
    const child = store.createConversation(projectId, "Child chat", { model: "gpt-test" });
    store.agentThreadManagement.attachManaged({
      childConversationId: child.id,
      sourceConversationId: parent.id,
      sourceTurnId: parentTurn.id,
      sourceRunId: parentTurn.runId,
      sourceHarnessId: "codex-app-server",
      now: new Date().toISOString(),
    });
    const childTurn = beginTurn(child.id);
    store.updateAgentTurnLifecycle(childTurn.id, { status: "failed", completedAt: new Date().toISOString() });
    store.limitResets.markUsageLimited(childTurn.id);
    store.updateWorkspaceRun(childTurn.runId, { status: "failed", finishedAt: new Date().toISOString() });
    store.updateWorkspaceRun(parentTurn.runId, { status: "succeeded", finishedAt: new Date().toISOString() });

    store.archiveConversation(parent.id, true);
    await expect(scheduler.schedule({
      conversationId: child.id,
      id: randomUUID(),
      failedTurnId: childTurn.id,
      resetsAt: RESET_AT,
    })).rejects.toThrow("parent was archived or deleted");
    expect((await scheduler.get(child.id)).offer).toBeNull();

    // Parent deleted -> source_conversation_id becomes NULL -> arming refused.
    store.archiveConversation(parent.id, false);
    store.deleteConversation(parent.id);
    await expect(scheduler.schedule({
      conversationId: child.id,
      id: randomUUID(),
      failedTurnId: childTurn.id,
      resetsAt: RESET_AT,
    })).rejects.toThrow("parent was archived or deleted");
  });
});
