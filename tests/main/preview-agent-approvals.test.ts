// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewAgentApprovalRegistry } from "../../src/main/preview-agent-approvals";
import type { PreviewAgentTarget } from "../../src/main/preview-agent-page";
import type { PreviewTab } from "../../src/main/preview-tab";
import type { AgentBrowserCommand } from "../../src/shared/agent-browser";
import { parseAgentBrowserApproval } from "../../src/shared/agent-browser-approval";

afterEach(() => vi.useRealTimers());

function fixture() {
  const tab = { id: crypto.randomUUID(), documentSequence: 1, pageNumber: 1,
    view: { webContents: { getTitle: () => "Checkout", getURL: () => "http://localhost:3000/",
      isDestroyed: () => false, isLoadingMainFrame: () => false } },
  } as unknown as PreviewTab;
  const scope = { activeTabId: tab.id, tabs: new Map([[tab.id, tab]]) };
  const identity = { conversationId: crypto.randomUUID(), runId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  const registry = new PreviewAgentApprovalRegistry();
  let target: PreviewAgentTarget = { found: true, label: "Message", editable: true, sensitive: false };
  const inspect = vi.fn(async () => ({ ...target }));
  const command: AgentBrowserCommand = { action: "type", ref: "e1", text: "Please deliver tomorrow", replace: true };
  const prepare = async (action: AgentBrowserCommand = command) => {
    const text = await registry.resolve({ action: "prepare-approval", command: action }, identity, scope, inspect);
    if (typeof text !== "string") throw new Error("Missing approval");
    const approval = parseAgentBrowserApproval(text);
    if (!approval) throw new Error("Invalid approval");
    return approval;
  };
  const execute = (token: string) => registry.resolve({ action: "perform-approved", token }, identity, scope, inspect);
  return { tab, scope, identity, registry, inspect, command, prepare, execute,
    setTarget: (next: PreviewAgentTarget) => { target = next; } };
}

describe("Browser approval authority", () => {
  it("describes the actual control and text, then consumes the exact command once", async () => {
    const f = fixture();
    const approval = await f.prepare();
    expect(approval.detail).toContain("Message");
    expect(approval.detail).toContain("Please deliver tomorrow");
    expect(approval.detail).not.toContain("e1");
    f.command.text = "changed after inspection";
    await expect(f.execute(approval.token)).resolves.toMatchObject({ command: { text: "Please deliver tomorrow" } });
    await expect(f.execute(approval.token)).rejects.toThrow("new approval");
  });

  it.each(["tab", "document", "closed", "label", "sensitive", "disabled"])(
    "refuses a changed %s after approval",
    async (change) => {
      const f = fixture();
      const approval = await f.prepare();
      if (change === "tab") f.scope.activeTabId = crypto.randomUUID();
      if (change === "document") f.tab.documentSequence += 1;
      if (change === "closed") f.scope.tabs.clear();
      if (["label", "sensitive", "disabled"].includes(change)) f.setTarget({
        found: true, label: change === "label" ? "Delete account" : "Message", editable: true,
        sensitive: change === "sensitive", disabled: change === "disabled",
      });
      await expect(f.execute(approval.token)).rejects.toThrow("new approval");
    },
  );

  it.each(["conversationId", "runId", "turnId"] as const)("refuses a different %s", async (key) => {
    const f = fixture();
    const approval = await f.prepare();
    await expect(f.registry.resolve({ action: "perform-approved", token: approval.token },
      { ...f.identity, [key]: crypto.randomUUID() }, f.scope, f.inspect)).rejects.toThrow("new approval");
    await expect(f.execute(approval.token)).resolves.toMatchObject({ command: { action: "type" } });
  });

  it("does not leak sensitive fields, recognized credentials or private URL parameters", async () => {
    const f = fixture();
    f.setTarget({ found: true, editable: true, sensitive: true, label: "Password field" });
    const secret = "arbitrary password only known to the field";
    const hidden = await f.prepare({ action: "type", ref: "e1", text: secret, replace: true });
    expect(hidden.detail).not.toContain(secret);
    expect(hidden.detail).toContain("sensitive text hidden");
    f.setTarget({ found: true, editable: true, sensitive: false, label: "Message" });
    const credential = "sk-abcdefgh1234567890";
    expect((await f.prepare({ action: "type", ref: "e1", text: credential, replace: true })).detail).not.toContain(credential);
    expect((await f.prepare({ action: "navigate", url: `http://localhost:3000/private?token=${credential}` })).detail).not.toContain(credential);
  });

  it("rejects navigation during inspection and cancellation before use", async () => {
    const f = fixture();
    f.inspect.mockImplementationOnce(async () => { f.tab.documentSequence += 1; return { found: true, label: "Changed" }; });
    await expect(f.prepare()).rejects.toThrow("new approval");
    const approval = await f.prepare();
    const controller = new AbortController(); controller.abort();
    await expect(f.registry.resolve({ action: "perform-approved", token: approval.token },
      f.identity, f.scope, f.inspect, controller.signal)).rejects.toThrow("new approval");
  });

  it("discards denied approvals and expires retained authority", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = await f.prepare();
    await f.registry.resolve({ action: "discard-approval", token: first.token }, f.identity, f.scope, f.inspect);
    await expect(f.execute(first.token)).rejects.toThrow("new approval");
    const second = await f.prepare();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(f.execute(second.token)).rejects.toThrow("new approval");
  });

  it("retains validation through asynchronous input delivery", async () => {
    const f = fixture();
    const resolved = await f.execute((await f.prepare()).token);
    if (typeof resolved === "string" || !("validate" in resolved)) throw new Error("Missing delivery authority");
    expect(() => resolved.validate({ found: true, label: "Changed on focus", editable: true, sensitive: false }))
      .toThrow("new approval");
    f.tab.documentSequence += 1;
    expect(() => resolved.validate()).toThrow("new approval");
  });

  it("bounds concurrently prepared approvals across independent slots", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const results = await Promise.allSettled(Array.from({ length: 65 }, () => f.prepare()));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(64);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(f.prepare()).resolves.toHaveProperty("token");
  });
});
