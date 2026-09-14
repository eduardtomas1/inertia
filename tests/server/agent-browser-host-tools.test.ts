import { describe, expect, it, vi } from "vitest";

import type { Conversation } from "../../src/shared/contracts";
import { AgentBrowserHostTools } from "../../src/server/runtime/agent-browser-host-tools";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const tabId = "22222222-2222-4222-8222-222222222222";
const identity = {
  conversationId,
  runId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
};

function conversation(accessMode: "supervised" | "auto-edit" | "full"): Conversation {
  return { id: conversationId, accessMode } as Conversation;
}

function call(tool: string, args: unknown, decision: "approve" | "deny" = "approve"): ProviderHostToolCall {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: crypto.randomUUID(),
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => decision),
  };
}

describe("agent browser host tools", () => {
  it("adds a bounded deterministic audit to semantic snapshots", async () => {
    const broker = { perform: vi.fn(async () => ({
      ok: true as const,
      text: JSON.stringify({
        title: "Local app",
        viewport: { width: 320, height: 200, scrollX: 0, scrollY: 0 },
        text: "Dashboard",
        elements: [{
          ref: "e1",
          role: "button",
          name: "",
          nameSource: "none",
          disabled: false,
          rect: { x: 10, y: 10, width: 20, height: 20 },
        }],
        truncated: false,
      }),
      state: {
        activeTabId: tabId,
        tabs: [{ id: tabId, title: "App", url: "http://127.0.0.1:3000", loading: false }],
        activity: null,
      },
    })) };
    const tools = new AgentBrowserHostTools(broker);
    const request = call("inertia_browser_snapshot", {});
    const result = await tools.invoke(conversation("supervised"), request, identity);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      inertiaAudit: {
        version: 1,
        errors: 1,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "missing-stable-name" }),
          expect.objectContaining({ code: "small-target" }),
        ]),
      },
    });
    expect(request.requestApproval).not.toHaveBeenCalled();
  });

  it("keeps screenshot bytes local even when a broker result regresses", async () => {
    const image = Buffer.from("png").toString("base64");
    const broker = { perform: vi.fn(async () => ({
      ok: true as const,
      text: "captured",
      state: {
        activeTabId: tabId,
        tabs: [{ id: tabId, title: "App", url: "http://127.0.0.1:3000", loading: false }],
        activity: null,
      },
      image: { mimeType: "image/png" as const, data: image },
    })) };
    const tools = new AgentBrowserHostTools(broker);
    const request = call("inertia_browser_screenshot", {});
    await expect(tools.invoke(conversation("supervised"), request, identity)).resolves.toEqual({
      success: true,
      text: "captured",
    });
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(broker.perform).toHaveBeenCalledWith(
      identity,
      { action: "screenshot" },
      request.signal,
    );
  });

  it.each(["approve", "deny"] as const)("prepares inspectable supervised actions and handles %s", async (decision) => {
    const token = crypto.randomUUID();
    const broker = { perform: vi.fn(async () => ({
      ok: true as const, text: JSON.stringify({ token, detail: 'Replace text in Message: "hello"' }),
      state: { activeTabId: tabId, tabs: [{ id: tabId, title: "App", url: "", loading: false }], activity: null },
    })) };
    const tools = new AgentBrowserHostTools(broker);
    const request = call("inertia_browser_interact", {
      action: "type", ref: "e4", text: "hello", replace: true,
    }, decision);
    await expect(tools.invoke(conversation("supervised"), request, identity))
      .resolves.toMatchObject({ success: decision === "approve" });
    expect(request.requestApproval).toHaveBeenCalledOnce();
    expect(request.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Replace text in Message: "hello"' }));
    expect(broker.perform).toHaveBeenNthCalledWith(1, identity, {
      action: "prepare-approval", command: { action: "type", ref: "e4", text: "hello", replace: true },
    }, request.signal);
    expect(broker.perform.mock.calls[1]).toEqual(decision === "approve"
      ? [identity, { action: "perform-approved", token }, request.signal]
      : [identity, { action: "discard-approval", token }]);
  });

  it("does not ask for approval or execute when the control cannot be inspected", async () => {
    const broker = { perform: vi.fn(async () => ({ ok: false as const, code: "not-found" as const, message: "stale control" })) };
    const request = call("inertia_browser_interact", { action: "click", ref: "e1" });
    await expect(new AgentBrowserHostTools(broker).invoke(conversation("supervised"), request, identity))
      .resolves.toMatchObject({ success: false });
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(broker.perform).toHaveBeenCalledOnce();
  });

  it.each(["Click \u202edelete", "Type \u0001text", "Open \u2066address"])("rejects unsafe approval display %j and discards its authority", async (detail) => {
    const token = crypto.randomUUID();
    const broker = { perform: vi.fn(async () => ({ ok: true as const, text: JSON.stringify({ token, detail }),
      state: { activeTabId: tabId, tabs: [], activity: null } })) };
    const request = call("inertia_browser_interact", { action: "click", ref: "e1" });
    await expect(new AgentBrowserHostTools(broker).invoke(conversation("supervised"), request, identity))
      .resolves.toMatchObject({ success: false });
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(broker.perform).toHaveBeenLastCalledWith(identity, { action: "discard-approval", token });
  });

  it.each(["auto-edit", "full"] as const)(
    "executes bounded interactions without a second approval in %s mode",
    async (accessMode) => {
      const broker = { perform: vi.fn(async () => ({
        ok: false as const, code: "not-found" as const, message: "stale ref",
      })) };
      const tools = new AgentBrowserHostTools(broker);
      const request = call("inertia_browser_interact", { action: "click", ref: "e2" });
      await expect(tools.invoke(conversation(accessMode), request, identity))
        .resolves.toMatchObject({ success: false });
      expect(request.requestApproval).not.toHaveBeenCalled();
      expect(broker.perform).toHaveBeenCalledWith(
        identity,
        { action: "click", ref: "e2" },
        request.signal,
      );
    },
  );
});
