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
  it("returns screenshot evidence directly without approval", async () => {
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
      image: { mimeType: "image/png", data: image },
    });
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(broker.perform).toHaveBeenCalledWith(
      identity,
      { action: "screenshot" },
      request.signal,
    );
  });

  it("requires supervised approval for interaction and does not act after denial", async () => {
    const broker = { perform: vi.fn() };
    const tools = new AgentBrowserHostTools(broker as never);
    const request = call("inertia_browser_interact", {
      action: "type", ref: "e4", text: "hello", replace: true,
    }, "deny");
    await expect(tools.invoke(conversation("supervised"), request, identity))
      .resolves.toMatchObject({ success: false });
    expect(request.requestApproval).toHaveBeenCalledOnce();
    expect(broker.perform).not.toHaveBeenCalled();
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
