// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { DelegatedTaskView } from "../../src/shared/orchestration-delegation";
import type { AgentApprovalDecision } from "../../src/server/provider/interactions";
import { SECRET_REQUEST_WAIT_MS_BY_PROVIDER } from "../../src/node/agent-secrets";
import { TASK_RUNNING_WAKE_NEXT } from "../../src/server/runtime/delegation/task-view";
import {
  clampDelegatedWaitTimeout,
  DELEGATED_WAIT_CALL_BUDGET_MS,
  delegatedWaitTimeout,
} from "../../src/server/runtime/delegation/task-wait";
import { createDelegationManagerFixture, errorCode, parsed } from "../support/delegation-manager-fixture";

const TASK = { task: "Run the slow migration suite and summarize failures.", title: "Migration suite" };

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => { if (!predicate()) throw new Error("not yet"); }, { timeout: 2_000, interval: 5 });
}

describe("inertia_wait_for_task", () => {
  it("reports a timeout while the child keeps running and upgrades settled_only to always", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const waited = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", { ...TASK, mode: "wait", timeoutMs: 20 }));
      expect(waited).toMatchObject({ status: "running", waitTimedOut: true, completionWake: "always", wakeArmed: true,
        next: TASK_RUNNING_WAKE_NEXT });
      expect(waited.next).toContain("do not wait on it or poll it");
      expect(waited.next).not.toContain("inertia_wait_for_task");
      expect(f.active.get(waited.conversationId)?.turnId).toBe(waited.firstTurnId);
      expect(f.store.agentTurn(waited.firstTurnId).status).not.toBe("cancelled");

      await f.settle(waited.firstTurnId, "completed", "Two migrations failed.");
      expect(f.service.view(waited.taskId)).toMatchObject({ status: "completed", delivery: { state: "claimed" } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)?.delegatedCompletion?.taskIds).toEqual([waited.taskId]);
      expect(f.offers).toContain(f.source.id);
    } finally { await f.close(); }
  });

  it("returns promptly when the child asks the user, without granting any permission power", async () => {
    const f = await createDelegationManagerFixture({ pollMs: 60_000 });
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", { ...TASK, wake: "settled_only" }));
      const started = Date.now();
      const waiting = f.invoke("inertia_wait_for_task", { taskId: view.taskId, timeoutMs: 1_800_000 });
      await new Promise((resolve) => setImmediate(resolve));
      const requestId = randomUUID();
      f.inputs.set(requestId, { id: requestId, providerId: "codex", conversationId: view.conversationId, runId: "run",
        turnId: view.firstTurnId, questions: [{ id: "q", header: "Choice", question: "Which schema?", options: [] }],
        autoResolutionMs: null } as never);
      f.service.signals.notify();
      const result = parsed<DelegatedTaskView>(await waiting);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result).toMatchObject({ status: "running", waitTimedOut: false,
        needsAction: { kind: "question", turnId: view.firstTurnId }, completionWake: "always",
        next: expect.stringContaining("Ask the user to answer in that chat") });
      expect(f.inputs.has(requestId)).toBe(true);
      expect(f.active.get(view.conversationId)?.turnId).toBe(view.firstTurnId);

      f.inputs.clear();
      const approvalId = randomUUID();
      f.approvals.set(approvalId, { id: approvalId, providerId: "codex", conversationId: view.conversationId, runId: "run",
        turnId: view.firstTurnId, kind: "command", title: "Run", detail: null, command: "rm -rf build", cwd: null, reason: null,
        networkScope: null } as never);
      const approval = parsed<DelegatedTaskView>(await f.invoke("inertia_wait_for_task", { taskId: view.taskId }));
      expect(approval.needsAction).toEqual({ kind: "approval", turnId: view.firstTurnId });
      expect(f.approvals.has(approvalId)).toBe(true);
    } finally { await f.close(); }
  });

  it("aborts with the parent tool-call signal and leaves the child and its wake untouched", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", { ...TASK, wake: "settled_only" }));
      const abort = new AbortController();
      const waiting = f.invoke("inertia_wait_for_task", { taskId: view.taskId }, { signal: abort.signal });
      await new Promise((resolve) => setImmediate(resolve));
      abort.abort();
      expect(errorCode(await waiting)).toBe("call_cancelled");
      expect(f.service.view(view.taskId)).toMatchObject({ status: "running", completionWake: "settled_only", wakeArmed: true });
      expect(f.active.get(view.conversationId)?.turnId).toBe(view.firstTurnId);
      expect(f.service.signals.size).toBe(0);
    } finally { await f.close(); }
  });

  it("does not hold the managed mutation queue while waiting", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const abort = new AbortController();
      let approvalAsked!: () => void;
      const asked = new Promise<void>((resolve) => { approvalAsked = resolve; });
      const waiting = f.invoke("inertia_delegate_task", { ...TASK, mode: "wait" }, { signal: abort.signal,
        approval: vi.fn(async (): Promise<AgentApprovalDecision> => { approvalAsked(); return "approve"; }) });
      await asked;
      await until(() => f.service.signals.size === 1);
      const child = f.store.agentThreadManagement.runsDispatchedByTurn(f.source.id, f.sourceTurn.id)[0]!;
      const send = await f.invoke("inertia_send_message", { conversationId: child.conversationId, content: "Include timings." });
      expect(send.success).toBe(true);
      const other = await f.invoke("inertia_delegate_task", { ...TASK, title: "Parallel work" });
      expect(other.success).toBe(true);
      expect(f.service.signals.size).toBe(1);
      abort.abort();
      expect(errorCode(await waiting)).toBe("call_cancelled");
    } finally { await f.close(); }
  });

  it("acknowledges a terminal result on wait and clamps the timeout", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const waiting = f.invoke("inertia_wait_for_task", { taskId: view.taskId, timeoutMs: 60_000 });
      await until(() => f.service.signals.size === 1);
      await f.settle(view.firstTurnId, "failed");
      const result = parsed<DelegatedTaskView>(await waiting);
      expect(result).toMatchObject({ status: "failed", waitTimedOut: false, delivery: { state: "acknowledged" },
        result: { status: "failed", text: expect.stringContaining("The delegated turn failed") } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();
      expect(errorCode(await f.invoke("inertia_wait_for_task", { taskId: view.taskId, timeoutMs: 1_800_001 })))
        .toBe("invalid_arguments");
      expect([clampDelegatedWaitTimeout(undefined), clampDelegatedWaitTimeout(0), clampDelegatedWaitTimeout(9e9)])
        .toEqual([240_000, 1, 1_800_000]);
    } finally { await f.close(); }
  });

  it("returns before a Node fetch client's 300 s cut by default, and within the call budget on bridged providers", () => {
    expect(delegatedWaitTimeout(undefined, "codex", 0)).toBe(240_000);
    expect(delegatedWaitTimeout(undefined, "claude", 200_000)).toBe(240_000);
    expect(delegatedWaitTimeout(1_800_000, "codex", 0)).toBe(1_800_000);
    expect(delegatedWaitTimeout(1_800_000, "opencode", 0)).toBe(1_800_000);
    for (const providerId of ["cursor", "kimi", "pi"] as const) {
      expect(DELEGATED_WAIT_CALL_BUDGET_MS[providerId]).toBe(SECRET_REQUEST_WAIT_MS_BY_PROVIDER[providerId]);
      expect(DELEGATED_WAIT_CALL_BUDGET_MS[providerId]).toBeLessThan(300_000);
      expect(delegatedWaitTimeout(undefined, providerId, 0)).toBe(240_000);
      expect(delegatedWaitTimeout(1_800_000, providerId, 0)).toBe(270_000);
      expect(delegatedWaitTimeout(undefined, providerId, 60_000)).toBe(210_000);
      expect(delegatedWaitTimeout(1_000, providerId, 60_000)).toBe(1_000);
      expect(delegatedWaitTimeout(undefined, providerId, 400_000)).toBe(1);
    }
  });

  it("counts the approval against the call budget on a bridged provider and keeps the long wait elsewhere", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const wait = vi.spyOn(f.service, "wait").mockImplementation(async (_caller, taskId) => f.service.view(taskId));
      const cursorTurn = { ...f.sourceTurn, providerId: "cursor" as const };
      let now = 1_000;
      const approvals: string[] = [];
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const delegated = await f.invokeAs({ conversation: f.source, turn: cursorTurn }, "inertia_delegate_task",
        { ...TASK, mode: "wait", timeoutMs: 1_800_000 },
        { approval: vi.fn(async (request): Promise<AgentApprovalDecision> => {
          approvals.push(request.detail);
          now += 100_000;
          return "approve";
        }) });
      const view = parsed<DelegatedTaskView>(delegated);
      expect(wait.mock.calls.at(-1)?.[2]).toBe(170_000);
      expect(approvals[0]).toContain("waits up to 4 min");
      expect(view).toMatchObject({ status: "running", taskId: expect.any(String) });

      parsed(await f.invokeAs({ conversation: f.source, turn: cursorTurn }, "inertia_wait_for_task",
        { taskId: view.taskId, timeoutMs: 1_800_000 }));
      expect(wait.mock.calls.at(-1)?.[2]).toBe(270_000);
      clock.mockRestore();
      parsed(await f.invoke("inertia_wait_for_task", { taskId: view.taskId, timeoutMs: 1_800_000 }));
      expect(wait.mock.calls.at(-1)?.[2]).toBe(1_800_000);
      await f.invoke("inertia_delegate_task", { ...TASK, title: "Long wait", mode: "wait", timeoutMs: 1_800_000 },
        { approval: vi.fn(async (request): Promise<AgentApprovalDecision> => { approvals.push(request.detail); return "approve"; }) });
      expect(approvals[1]).toContain("waits up to 30 min");
      expect(wait.mock.calls.at(-1)?.[2]).toBe(1_800_000);
    } finally { await f.close(); }
  });

  it("reuses the chat a cancelled wait created when the agent retries the same request", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const approval = vi.fn(async (): Promise<AgentApprovalDecision> => "approve");
      const cancelled = async (args: Record<string, unknown>) => {
        const abort = new AbortController();
        const waiting = f.invoke("inertia_delegate_task", args, { signal: abort.signal, approval });
        await until(() => f.service.signals.size === 1);
        abort.abort();
        expect(errorCode(await waiting)).toBe("call_cancelled");
      };
      const request = { ...TASK, mode: "wait", timeoutMs: 20 };
      await cancelled(request);
      expect(f.starts).toHaveLength(1);
      const retried = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", request, { approval }));
      expect(f.starts).toHaveLength(1);
      expect(approval).toHaveBeenCalledOnce();
      expect(retried).toMatchObject({ status: "running", waitTimedOut: true, firstTurnId: f.starts[0] });

      // Only a cancelled identical request is reused; an answered one or a different one is a new task.
      await f.invoke("inertia_delegate_task", request, { approval });
      expect(f.starts).toHaveLength(2);

      const keyed = { ...TASK, title: "Keyed", mode: "wait", timeoutMs: 20, clientRequestId: "retry-1" };
      await cancelled(keyed);
      expect(f.starts).toHaveLength(3);
      const replayed = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", keyed, { approval }));
      expect(f.starts).toHaveLength(3);
      expect(replayed).toMatchObject({ title: "Keyed", firstTurnId: f.starts[2] });
    } finally { await f.close(); }
  });

  it.each(["inertia_get_task_status", "inertia_wait_for_task", "inertia_cancel_task"] as const)(
    "stops reusing a cancelled wait's chat once the agent names its handle with %s",
    async (tool) => {
      const f = await createDelegationManagerFixture();
      try {
        const approval = vi.fn(async (): Promise<AgentApprovalDecision> => "approve");
        const request = { ...TASK, mode: "wait", timeoutMs: 20 };
        const abort = new AbortController();
        const waiting = f.invoke("inertia_delegate_task", request, { signal: abort.signal, approval });
        await until(() => f.service.signals.size === 1);
        abort.abort();
        expect(errorCode(await waiting)).toBe("call_cancelled");
        const created = f.service.view(f.store.orchestration.delegation.reads.taskForChildTurn(f.starts[0]!)!);
        const named = await f.invoke(tool, tool === "inertia_wait_for_task" ? { taskId: created.taskId, timeoutMs: 1 }
          : { taskId: created.taskId }, { approval });
        expect(named.success, named.text).toBe(true);

        await f.invoke("inertia_delegate_task", request, { approval });
        expect(f.starts).toHaveLength(2);
        expect(approval).toHaveBeenCalledTimes(tool === "inertia_cancel_task" ? 3 : 2);
      } finally { await f.close(); }
    },
  );
});
