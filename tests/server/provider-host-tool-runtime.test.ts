// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import type { AgentApprovalRequest } from "../../src/server/provider/interactions";

const owners: ProviderHostToolRuntime[] = [];
const approval = {
  title: "Create chat", detail: "Create a verifier chat.",
  reason: "The agent requested it.", permissionRoots: [],
};

afterEach(() => {
  for (const owner of owners.splice(0)) owner.settle();
});

function fixture(
  invoke: ProviderHostToolBridge["invoke"],
  onApproval?: () => void,
) {
  const approvals: AgentApprovalRequest[] = [];
  const resolved: Array<[string, string]> = [];
  const owner = new ProviderHostToolRuntime({
    bridge: {
      definitions: [{
        name: "inertia_create_conversation", description: "Create a chat.",
        inputSchema: { type: "object", properties: {} }, readOnly: false,
      }],
      invoke,
    },
    conversationId: "thread", turnId: "turn", cwd: "/project",
    onApproval: (request) => { approvals.push(request); onApproval?.(); },
    onApprovalResolved: (requestId, decision) => resolved.push([requestId, decision]),
  });
  owners.push(owner);
  return {
    owner, approvals, resolved,
    invoke: (callId: string, signal?: AbortSignal) => owner.invoke({
      callId, tool: "inertia_create_conversation", arguments: {}, signal,
    }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("provider host-tool cancellation authority", () => {
  it("does not dispatch an already-cancelled call or allow its identity to be replayed", async () => {
    const dispatch = vi.fn(async () => ({ success: true, text: "created" }));
    const { invoke, owner, approvals } = fixture(dispatch);
    const controller = new AbortController();
    controller.abort();
    expect(await invoke("cancelled", controller.signal)).toMatchObject({
      success: false, text: expect.stringContaining("cancelled"),
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(approvals).toEqual([]);
    expect(owner.cancelCall("cancelled")).toBe(false);
    expect(await invoke("cancelled")).toMatchObject({
      success: false, text: expect.stringContaining("reused"),
    });
  });

  it("refuses approval registration after cancellation during asynchronous preparation", async () => {
    const prepared = deferred();
    const decisions: string[] = [];
    const { invoke, approvals, resolved } = fixture(async (call) => {
      await prepared.promise;
      const decision = await call.requestApproval(approval);
      decisions.push(decision);
      return { success: decision === "approve", text: decision };
    });
    const controller = new AbortController();
    const result = invoke("preparing", controller.signal);
    controller.abort();
    prepared.resolve();
    await vi.waitFor(() => expect(decisions).toEqual(["cancel"]));
    expect(await result).toMatchObject({ success: false, text: expect.stringContaining("cancelled") });
    expect(approvals).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it("resolves approval exactly once when its notification cancels the call", async () => {
    const controller = new AbortController();
    const decisions: string[] = [];
    let lateApprovalAccepted: boolean | undefined;
    const { invoke, owner, approvals, resolved } = fixture(async (call) => {
      call.signal.addEventListener("abort", () => {
        lateApprovalAccepted = owner.respondToApproval(approvals[0]!.requestId, "approve");
      }, { once: true });
      const decision = await call.requestApproval(approval);
      decisions.push(decision);
      return { success: decision === "approve", text: decision };
    }, () => controller.abort());
    const result = invoke("approval-race", controller.signal);
    await vi.waitFor(() => expect(decisions).toEqual(["cancel"]));
    expect(lateApprovalAccepted).toBe(false);
    expect(await result).toMatchObject({ success: false, text: expect.stringContaining("cancelled") });
    const requestId = approvals[0]!.requestId;
    expect(owner.respondToApproval(requestId, "approve")).toBe(false);
    owner.settle();
    expect(resolved).toEqual([[requestId, "cancelled"]]);
  });

  it("retains cancelled call slots until their bridge cleanup finishes", async () => {
    const cleanup = deferred();
    let requiresApproval = true;
    const { invoke, owner, approvals, resolved } = fixture(async (call) => {
      if (!requiresApproval) return { success: true, text: "created" };
      const decision = await call.requestApproval(approval);
      await cleanup.promise;
      return { success: decision === "approve", text: decision };
    });
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const calls = controllers.map((controller, index) => invoke(`pending-${index}`, controller.signal));
    try {
      expect(approvals).toHaveLength(8);
      for (const controller of controllers) controller.abort();
      expect(resolved).toEqual(approvals.map(({ requestId }) => [requestId, "cancelled"]));
      expect(await invoke("while-cleaning")).toMatchObject({
        success: false, text: expect.stringContaining("8 Inertia tool calls are already running"),
      });
      cleanup.resolve();
      expect((await Promise.all(calls)).every(({ success }) => !success)).toBe(true);
      requiresApproval = false;
      expect(await invoke("after-cleanup")).toEqual({ success: true, text: "created" });
      expect(await invoke("pending-0")).toMatchObject({ success: false, text: expect.stringContaining("reused") });
    } finally {
      owner.settle();
      cleanup.resolve();
      await Promise.all(calls);
    }
  });
});
