import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { cursorSdkHostTools, CURSOR_SDK_HOST_TOOL_TIMEOUT_MS } from "../../src/server/provider/cursor-sdk-host-tools";
import type { CursorSdkStart } from "../../src/node/cursor-sdk-protocol";
import { CursorSdkChannel } from "../../src/node/cursor-sdk-channel";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";

const input: CursorSdkStart = { authority: { conversationId: "chat", turnId: "turn", runId: "run", providerInstanceId: "instance", workspace: "/workspace" },
  apiKey: "synthetic-test-token", stateRoot: "/state", prompt: "hello", model: "synthetic-model", nativeTools: "read",
  tools: [{ name: "tool", description: "Test", inputSchema: { type: "object" }, readOnly: true }] };
describe("Cursor SDK host callback authority", () => {
  it("forwards only exact native session callbacks with private native IDs", async () => {
    const request = vi.fn(async () => ({ result: "done" }));
    const tools = cursorSdkHostTools(input, () => "native", new AbortController().signal, request);
    await expect(tools.tool!.execute({}, { sessionId: "native", toolCallId: "sdk-call" })).resolves.toEqual({ result: "done" });
    expect(request).toHaveBeenCalledWith("host-tool", expect.objectContaining({ authority: input.authority, tool: "tool" }), CURSOR_SDK_HOST_TOOL_TIMEOUT_MS);
    expect(JSON.stringify(request.mock.calls)).not.toContain("sdk-call");
    await expect(tools.tool!.execute({}, { sessionId: "native", toolCallId: "sdk-call" })).rejects.toThrow("reused");
    expect(request).toHaveBeenCalledOnce();
  });
  it("rejects child sessions, absent session authority and cancelled owners", async () => {
    const request = vi.fn(async () => null); const controller = new AbortController();
    const tools = cursorSdkHostTools(input, () => "parent", controller.signal, request);
    await expect(tools.tool!.execute({}, { sessionId: "child", toolCallId: "one" })).rejects.toThrow("authority");
    await expect(tools.tool!.execute({}, { toolCallId: "two" })).rejects.toThrow("authority");
    controller.abort(); await expect(tools.tool!.execute({}, { sessionId: "parent", toolCallId: "three" })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["approve", "cancel"] as const)("preserves delayed host approval through the actual private channel: %s", async (decision) => {
    vi.useFakeTimers();
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const controller = new AbortController();
    const failed = vi.fn();
    let approvalId = "";
    const host = new ProviderHostToolRuntime({
      conversationId: "chat", turnId: "turn", cwd: "/workspace",
      onApproval: (request) => { approvalId = request.requestId; }, onApprovalResolved: () => undefined,
      bridge: { definitions: input.tools, invoke: async (call) => {
        const approved = await call.requestApproval({ title: "Fixture approval", detail: "Fixture operation", reason: "Fixture", permissionRoots: [] });
        if (approved !== "approve") return { success: false, text: "cancelled" };
        await new Promise((resolve) => setTimeout(resolve, 45_000));
        return { success: true, text: "done" };
      } },
    });
    const worker = new CursorSdkChannel(inbound, outbound, async () => null, failed);
    const parent = new CursorSdkChannel(outbound, inbound, async (_method, value) => {
      const call = value as { callId: string; tool: string; arguments: unknown };
      return host.invoke({ ...call, signal: controller.signal });
    }, failed);
    const tools = cursorSdkHostTools(input, () => "native", controller.signal,
      (method, value, timeout) => worker.request(method, value, timeout));
    const outcome = Promise.resolve(tools.tool!.execute({}, { sessionId: "native", toolCallId: "delayed-approval" }))
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(approvalId).not.toBe("");
      expect(failed).not.toHaveBeenCalled();
      if (decision === "approve") {
        expect(host.respondToApproval(approvalId, "approve")).toBe(true);
        await vi.advanceTimersByTimeAsync(45_000);
        expect(await outcome).toEqual({ value: { success: true, text: "done" } });
        expect(failed).not.toHaveBeenCalled();
      } else {
        controller.abort();
        host.settle();
        worker.close();
        expect(await outcome).toHaveProperty("error");
        expect(host.respondToApproval(approvalId, "approve")).toBe(false);
      }
    } finally {
      controller.abort();
      host.settle();
      worker.close();
      parent.close();
      await outcome;
      vi.useRealTimers();
    }
  });
});
