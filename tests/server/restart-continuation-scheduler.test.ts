// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING } from "../../src/shared/watcher";
import { RuntimeStore } from "../../src/server/database";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import type { RestartContinuationPlan } from "../../src/server/persistence/restart-continuation-repository";
import {
  RestartContinuationScheduler,
  type RestartContinuationDependencies,
} from "../../src/server/runtime/restart-continuation-scheduler";

let directory: string;
let databasePath: string;
let store: RuntimeStore;
let projectId: string;
let abort: AbortController;
let held: boolean;
let busy: Set<string>;
let pending: Set<string>;
let dependencies: RestartContinuationDependencies;
let scheduler: RestartContinuationScheduler;

function begin(conversationId: string, content = "Refactor the parser.", restartContinuationPlanId?: string) {
  vi.setSystemTime(Date.now() + 1_000);
  const conversation = store.conversation(conversationId);
  const run = store.createWorkspaceRun({ kind: "agent", projectId, conversationId, label: "Task", detail: null, status: "running", port: null });
  return store.beginAgentTurn({ conversationId, runId: run.id, content, providerId: conversation.providerId,
    modelSelection: conversation.modelSelection, model: "gpt-test", reasoningEffort: conversation.reasoningEffort,
    interactionMode: conversation.interactionMode, accessMode: conversation.accessMode, configurationRevision: 0,
    association: "authoritative", restartContinuationPlanId }).turn;
}

function settle(turnId: string, status: "interrupted" | "cancelled" | "completed", terminalReason: string) {
  const at = new Date().toISOString();
  store.updateAgentTurnLifecycle(turnId, { status, terminalReason, startedAt: at, completedAt: at });
}

function queuedChat(title = "Queued task") {
  const conversationId = store.createConversation(projectId, title, { model: "gpt-test" }).id;
  const turn = begin(conversationId);
  return { conversationId, turnId: turn.id };
}

function runningChat(title = "Running task", status: "starting" | "running" = "running") {
  const chat = queuedChat(title);
  store.updateAgentTurnLifecycle(chat.turnId, { status });
  return chat;
}

function plannedChat(title?: string) {
  const chat = runningChat(title);
  expect(scheduler.createPlans([chat.conversationId])).toEqual([chat.conversationId]);
  settle(chat.turnId, "interrupted", "app-update");
  return chat;
}

const plan = (conversationId: string): RestartContinuationPlan | null => store.restartContinuations.forConversation(conversationId);

beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), "inertia-restart-scheduler-"));
  databasePath = join(directory, "inertia.sqlite");
  store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  projectId = store.createProject("Project", directory).id;
  abort = new AbortController();
  held = false;
  busy = new Set();
  pending = new Set();
  dependencies = {
    store, signal: abort.signal, enabled: true,
    held: () => held,
    busy: (conversationId) => busy.has(conversationId),
    pendingInteraction: (conversationId) => pending.has(conversationId),
    dispatch: vi.fn(async (claimed: RestartContinuationPlan, guard: () => void) => {
      guard();
      begin(claimed.conversationId, "Continue from where you stopped.", claimed.id);
    }),
    track: async (operation) => await operation(),
  };
  scheduler = new RestartContinuationScheduler(dependencies);
});

afterEach(() => {
  abort.abort();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("restart continuation plans", () => {
  it("plans only running chats that can continue on their own", () => {
    const running = runningChat("Running");
    const starting = runningChat("Starting", "starting");
    const notStarted = queuedChat("Not started");
    const approval = runningChat("Approval");
    store.updateAgentTurnLifecycle(approval.turnId, { status: "waiting-for-approval" });
    const asking = runningChat("Asking");
    pending.add(asking.conversationId);
    const archived = runningChat("Archived");
    store.archiveConversation(archived.conversationId, true);
    const queued = runningChat("Queued");
    store.queuedMessages.add({ id: randomUUID(), conversation: store.conversation(queued.conversationId),
      content: "Then the tests.", attachments: [], digest: "a".repeat(64) });
    const finished = runningChat("Finished");
    settle(finished.turnId, "completed", "provider-completed");
    const empty = store.createConversation(projectId, "Empty", { model: "gpt-test" }).id;

    expect(scheduler.createPlans([running.conversationId, approval.conversationId, asking.conversationId, notStarted.conversationId,
      archived.conversationId, queued.conversationId, finished.conversationId, empty, "missing", running.conversationId, starting.conversationId]))
      .toEqual([running.conversationId, starting.conversationId]);
    expect(plan(notStarted.conversationId)).toBeNull();
    expect(plan(running.conversationId)).toMatchObject({ interruptedTurnId: running.turnId, state: "waiting" });
    expect(plan(approval.conversationId)).toBeNull();
  });

  it("never plans a continuation for an attached watcher's own chat", () => {
    const watched = runningChat("Watched");
    const { link, conversation: watcher } = store.watcherLinks.createWithConversation({
      link: {
        id: randomUUID(), watchedConversationId: watched.conversationId, preset: "reviewer", instructions: "",
        sharing: { ...DEFAULT_WATCHER_SHARING }, budgets: { ...DEFAULT_WATCHER_BUDGETS }, privateConnect: "inherit",
      },
      conversation: { projectId, title: "Watcher", options: { model: "gpt-test", interactionMode: "plan", accessMode: "supervised" } },
    }, new Date().toISOString());
    const check = begin(watcher.id, "Check 1.");
    store.updateAgentTurnLifecycle(check.id, { status: "running" });

    expect(scheduler.createPlans([watched.conversationId, watcher.id])).toEqual([watched.conversationId]);
    expect(plan(watcher.id)).toBeNull();
    expect(store.watcherLinks.get(link.id)?.status).toBe("watching");
  });

  it("plans nothing when providers are disabled", () => {
    dependencies.enabled = false;
    scheduler = new RestartContinuationScheduler(dependencies);
    const chat = runningChat();
    expect(scheduler.createPlans([chat.conversationId])).toEqual([]);
    expect(plan(chat.conversationId)).toBeNull();
  });
});

describe("restart continuation dispatch", () => {
  it("sends one continuation per plan and completes it with the new turn", async () => {
    const first = plannedChat("First");
    const second = plannedChat("Second");
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    await scheduler.tick();
    expect(dependencies.dispatch).toHaveBeenCalledTimes(2);
    for (const chat of [first, second]) {
      const latest = store.latestAgentTurnForConversation(chat.conversationId)!;
      expect(latest.id).not.toBe(chat.turnId);
      expect(plan(chat.conversationId)).toMatchObject({ state: "completed", turnId: latest.id, attempts: 1 });
    }
  });

  it("waits while the planned turn is still running, the chat is busy or the update hold is held", async () => {
    const chat = runningChat();
    scheduler.createPlans([chat.conversationId]);
    await scheduler.tick();
    expect(plan(chat.conversationId)).toMatchObject({ state: "waiting", attempts: 0 });
    settle(chat.turnId, "interrupted", "app-update");
    busy.add(chat.conversationId);
    await scheduler.tick();
    busy.clear();
    held = true;
    await scheduler.tick();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    expect(plan(chat.conversationId)).toMatchObject({ state: "waiting", attempts: 0 });
    held = false;
    await scheduler.tick();
    expect(plan(chat.conversationId)).toMatchObject({ state: "completed" });
  });

  it.each([
    ["archived", "The chat was archived."],
    ["new-turn", "The chat moved on before it could continue."],
    ["stopped", "The interrupted turn ended another way."],
    ["route", "The chat's model or workspace changed."],
    ["queued", "The chat has a queued message."],
    ["question", "The chat is waiting for an answer."],
  ] as const)("cancels a stale plan when the chat was %s", async (change, reason) => {
    const chat = runningChat();
    scheduler.createPlans([chat.conversationId]);
    settle(chat.turnId, change === "stopped" ? "cancelled" : "interrupted", change === "stopped" ? "user-cancelled" : "app-update");
    if (change === "archived") store.archiveConversation(chat.conversationId, true);
    if (change === "new-turn") begin(chat.conversationId, "Something else.");
    if (change === "route") store.updateConversation(chat.conversationId, { accessMode: "full" });
    if (change === "queued") store.queuedMessages.add({ id: randomUUID(), conversation: store.conversation(chat.conversationId),
      content: "Then the tests.", attachments: [], digest: "a".repeat(64) });
    if (change === "question") pending.add(chat.conversationId);
    await scheduler.tick();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    expect(plan(chat.conversationId)).toMatchObject({ state: "cancelled", error: reason, turnId: null });
  });

  it("cancels when the chat changes during dispatch without creating a turn", async () => {
    const chat = plannedChat();
    dependencies.dispatch = vi.fn(async (claimed: RestartContinuationPlan, guard: () => void) => {
      store.archiveConversation(chat.conversationId, true);
      guard();
      begin(claimed.conversationId, "Continue from where you stopped.", claimed.id);
    });
    await scheduler.tick();
    expect(plan(chat.conversationId)).toMatchObject({ state: "cancelled", error: "The chat was archived.", turnId: null });
    expect(store.latestAgentTurnForConversation(chat.conversationId)?.id).toBe(chat.turnId);
  });

  it("refuses a dispatch that starts while the update hold is held", async () => {
    const chat = plannedChat();
    dependencies.dispatch = vi.fn(async (claimed: RestartContinuationPlan, guard: () => void) => {
      held = true;
      guard();
      begin(claimed.conversationId, "Continue from where you stopped.", claimed.id);
    });
    await scheduler.tick();
    expect(store.latestAgentTurnForConversation(chat.conversationId)?.id).toBe(chat.turnId);
    expect(plan(chat.conversationId)).toMatchObject({ state: "waiting", turnId: null });
  });

  it("retries a failed dispatch with backoff and blocks it after three failures", async () => {
    const chat = plannedChat();
    dependencies.dispatch = vi.fn(async () => { throw new RuntimeRequestError("The provider is not ready."); });
    await scheduler.tick();
    expect(plan(chat.conversationId)).toMatchObject({ state: "waiting", attempts: 1, error: "The provider is not ready." });
    await scheduler.tick();
    expect(dependencies.dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(plan(chat.conversationId)).toMatchObject({ state: "waiting", attempts: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dependencies.dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(plan(chat.conversationId)).toMatchObject({ state: "blocked", attempts: 3, error: "The provider is not ready." });
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.tick();
    expect(dependencies.dispatch).toHaveBeenCalledTimes(3);
  });

  it("treats a dispatch that creates no turn as a failure", async () => {
    const chat = plannedChat();
    dependencies.dispatch = vi.fn(async () => undefined);
    await scheduler.tick();
    expect(plan(chat.conversationId)).toMatchObject({ state: "waiting", attempts: 1, turnId: null,
      error: "The continuation could not be confirmed." });
  });

  it("resumes an unconfirmed dispatch after a restart without replaying a confirmed one", async () => {
    const unconfirmed = plannedChat("Unconfirmed");
    const confirmed = plannedChat("Confirmed");
    store.restartContinuations.claim(plan(unconfirmed.conversationId)!);
    await scheduler.tick();
    expect(plan(confirmed.conversationId)?.state).toBe("completed");
    store.close();
    store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    dependencies.store = store;
    scheduler = new RestartContinuationScheduler(dependencies);
    scheduler.start();
    expect(plan(unconfirmed.conversationId)).toMatchObject({ state: "waiting", attempts: 1 });
    await scheduler.tick();
    expect(plan(unconfirmed.conversationId)).toMatchObject({ state: "completed", attempts: 2 });
    expect(dependencies.dispatch).toHaveBeenCalledTimes(2);
  });

  it("dispatches from its own timer after start and after arm", async () => {
    const chat = plannedChat();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(plan(chat.conversationId)?.state).toBe("completed");
    const next = plannedChat("Next");
    scheduler.arm();
    await vi.advanceTimersByTimeAsync(0);
    expect(plan(next.conversationId)?.state).toBe("completed");
  });

  it("only reconciles at start when providers are disabled", async () => {
    const chat = plannedChat();
    store.restartContinuations.claim(plan(chat.conversationId)!);
    dependencies.enabled = false;
    scheduler = new RestartContinuationScheduler(dependencies);
    scheduler.start();
    scheduler.arm();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.tick();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    expect(plan(chat.conversationId)?.state).toBe("waiting");
  });
});
