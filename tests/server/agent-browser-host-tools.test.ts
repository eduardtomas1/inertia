import { describe, expect, it, vi } from "vitest";

import type { Conversation } from "../../src/shared/contracts";
import { MAX_AGENT_BROWSER_IMAGE_BYTES, MAX_AGENT_BROWSER_IMAGE_EDGE } from "../../src/shared/agent-browser";
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

  it("tells the model in a snapshot that the user has been using the page", async () => {
    const broker = { perform: vi.fn(async () => ({
      ok: true as const,
      text: JSON.stringify({ title: "Local app", viewport: {}, text: "", elements: [] }),
      state: {
        activeTabId: tabId,
        tabs: [{ id: tabId, title: "App", url: "http://127.0.0.1:3000", loading: false }],
        activity: null,
        controller: "user" as const,
      },
    })) };
    const result = await new AgentBrowserHostTools(broker)
      .invoke(conversation("full"), call("inertia_browser_snapshot", {}), identity);
    expect(JSON.parse(result.text)).toMatchObject({ tabId, controller: "user", title: "Local app" });
  });

  const pageState = {
    activeTabId: tabId,
    tabs: [{ id: tabId, title: "App", url: "http://127.0.0.1:3000", loading: false }],
    activity: null,
  };
  const capturedText = JSON.stringify({ captured: true, tabId, url: "http://127.0.0.1:3000", width: 4, height: 4 });
  const png = Buffer.from("png").toString("base64");

  function screenshotBroker(image: { mimeType: "image/png"; data: string; width: number; height: number }) {
    const token = crypto.randomUUID();
    return {
      token,
      perform: vi.fn(async (_identity: unknown, request: { action: string }) => request.action === "prepare-approval"
        ? { ok: true as const, text: JSON.stringify({ token, detail: "Browser tab 1\nSend a screenshot of the Browser page to the provider" }), state: pageState }
        : { ok: true as const, text: capturedText, state: pageState, image }),
    };
  }

  it.each(["auto-edit", "full"] as const)("returns the screenshot image to a model that accepts images in %s mode", async (accessMode) => {
    const broker = screenshotBroker({ mimeType: "image/png", data: png, width: 4, height: 4 });
    const request = call("inertia_browser_screenshot", {});
    const result = await new AgentBrowserHostTools(broker).invoke(conversation(accessMode), request, identity, true);
    expect(result).toEqual({
      success: true,
      text: JSON.stringify({ captured: true, tabId, url: "http://127.0.0.1:3000", width: 4, height: 4, providerImage: true, state: pageState }),
      images: [{ mimeType: "image/png", data: png }],
    });
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(broker.perform).toHaveBeenCalledExactlyOnceWith(identity, { action: "screenshot" }, request.signal);
  });

  it.each(["supervised", "full"] as const)("keeps the screenshot on the device without approval when the model cannot see images in %s mode", async (accessMode) => {
    const broker = screenshotBroker({ mimeType: "image/png", data: png, width: 4, height: 4 });
    const request = call("inertia_browser_screenshot", {});
    const result = await new AgentBrowserHostTools(broker).invoke(conversation(accessMode), request, identity, false);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({
      captured: true,
      tabId,
      url: "http://127.0.0.1:3000",
      width: 4,
      height: 4,
      providerImage: false,
      note: "The image stayed on the user's device. Use inertia_browser_snapshot to read the page.",
      state: pageState,
    });
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(broker.perform).toHaveBeenCalledExactlyOnceWith(identity, { action: "screenshot" }, request.signal);
  });

  it("asks before sending a screenshot to the provider in a supervised chat", async () => {
    const broker = screenshotBroker({ mimeType: "image/png", data: png, width: 4, height: 4 });
    const request = call("inertia_browser_screenshot", {});
    const result = await new AgentBrowserHostTools(broker).invoke(conversation("supervised"), request, identity, true);
    expect(result.images).toEqual([{ mimeType: "image/png", data: png }]);
    expect(JSON.parse(result.text)).toMatchObject({ providerImage: true });
    expect(request.requestApproval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      detail: "Browser tab 1\nSend a screenshot of the Browser page to the provider",
    }));
    expect(broker.perform.mock.calls).toEqual([
      [identity, { action: "prepare-approval", command: { action: "screenshot" } }, request.signal],
      [identity, { action: "perform-approved", token: broker.token }, request.signal],
    ]);
  });

  it("captures nothing when the user denies sending a screenshot", async () => {
    const broker = screenshotBroker({ mimeType: "image/png", data: png, width: 4, height: 4 });
    const request = call("inertia_browser_screenshot", {}, "deny");
    const result = await new AgentBrowserHostTools(broker).invoke(conversation("supervised"), request, identity, true);
    expect(result.success).toBe(false);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.text)).toMatchObject({ error: { code: "user_denied" } });
    expect(broker.perform.mock.calls.map(([, command]) => command.action))
      .toEqual(["prepare-approval", "discard-approval"]);
  });

  it.each([
    ["an edge over the limit", { mimeType: "image/png" as const, data: png, width: MAX_AGENT_BROWSER_IMAGE_EDGE + 1, height: 4 }],
    ["more bytes than the limit", {
      mimeType: "image/png" as const,
      data: Buffer.alloc(MAX_AGENT_BROWSER_IMAGE_BYTES + 3).toString("base64"),
      width: 4,
      height: 4,
    }],
    ["malformed base64", { mimeType: "image/png" as const, data: "not base64!", width: 4, height: 4 }],
  ])("refuses to send a screenshot with %s", async (_label, image) => {
    const broker = screenshotBroker(image);
    const result = await new AgentBrowserHostTools(broker)
      .invoke(conversation("full"), call("inertia_browser_screenshot", {}), identity, true);
    expect(result.success).toBe(false);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.text)).toMatchObject({ error: { code: "too-large", reachedPage: false } });
  });

  it("never forwards an image from a command other than screenshot", async () => {
    const broker = screenshotBroker({ mimeType: "image/png", data: png, width: 4, height: 4 });
    const result = await new AgentBrowserHostTools(broker)
      .invoke(conversation("full"), call("inertia_browser_click", { ref: "e1" }), identity, true);
    expect(result.images).toBeUndefined();
  });

  it("adds the viewport setting to a snapshot's page viewport", async () => {
    const viewport = { width: 1_280, height: 800, fit: false, mobile: false, colorScheme: "dark" as const };
    const broker = { perform: vi.fn(async () => ({
      ok: true as const,
      text: JSON.stringify({ title: "Local app", viewport: { width: 1_280, height: 800, scrollX: 0, scrollY: 40 }, text: "", elements: [] }),
      state: { ...pageState, viewport },
    })) };
    const result = await new AgentBrowserHostTools(broker)
      .invoke(conversation("full"), call("inertia_browser_snapshot", {}), identity);
    expect(JSON.parse(result.text).viewport).toEqual({
      width: 1_280, height: 800, scrollX: 0, scrollY: 40, fit: false, mobile: false, colorScheme: "dark",
    });
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

  it.each([
    [{ code: "invalid" as const, message: "Not accepted." }, false, false],
    [{ code: "not-found" as const, message: "Stale." }, true, false],
    [{ code: "sensitive" as const, message: "Withheld." }, false, false],
    [{ code: "too-large" as const, message: "Too many tabs." }, true, false],
    [{ code: "unavailable" as const, message: "Refused." }, true, false],
    [{ code: "timeout" as const, message: "Nothing was sent." }, true, false],
    [{ code: "timeout" as const, message: "Input may have reached the page.", reachedPage: true }, true, true],
    [{ code: "cancelled" as const, message: "Cancelled." }, false, false],
  ])("states whether failure %j can be retried and whether it reached the page", async (failure, retryable, reachedPage) => {
    const broker = { perform: vi.fn(async () => ({ ok: false as const, ...failure })) };
    const result = await new AgentBrowserHostTools(broker)
      .invoke(conversation("full"), call("inertia_browser_click", { ref: "e1" }), identity);
    expect(JSON.parse(result.text)).toEqual({
      error: { code: failure.code, message: failure.message, retryable, reachedPage },
    });
  });

  it("marks rejected arguments, denials and cancellations as not retryable and not reaching the page", async () => {
    const broker = { perform: vi.fn(async () => ({
      ok: true as const, text: JSON.stringify({ token: crypto.randomUUID(), detail: "Browser tab 1" }),
      state: { activeTabId: tabId, tabs: [], activity: null },
    })) };
    const tools = new AgentBrowserHostTools(broker);
    for (const [request, code] of [
      [call("inertia_browser_click", {}), "invalid"],
      [call("inertia_browser_click", { ref: "e1" }, "deny"), "user_denied"],
    ] as const) {
      const result = await tools.invoke(conversation("supervised"), request, identity);
      expect(JSON.parse(result.text)).toMatchObject({ error: { code, retryable: false, reachedPage: false } });
    }
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
