import { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, afterEach, vi } from "vitest";
import { startCursorSdkRun } from "../../src/server/provider/cursor-sdk-harness";
import type { openCursorSdkWorker } from "../../src/server/provider/cursor-sdk-process";
import type { CursorSdkStart } from "../../src/node/cursor-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";
import type { AgentHarnessEvent, AgentHarnessStartOptions } from "../../src/server/provider/agent-harness";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });
async function fixture(body?: (input: CursorSdkStart, handle: Parameters<typeof openCursorSdkWorker>[0]["handle"]) => Promise<unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-sdk-harness-"))); roots.push(root);
  const events: AgentHarnessEvent[] = [];
  const close = vi.fn(async () => undefined);
  const request = vi.fn(async (_method: string, _params: unknown, _timeout?: number) => null as unknown);
  const openWorker = vi.fn(async (options: Parameters<typeof openCursorSdkWorker>[0]) => {
    request.mockImplementation(async (method?: unknown, value?: unknown) => {
      if (method !== "start") return "revert_to_followup";
      const input = value as CursorSdkStart;
      if (body) return body(input, options.handle);
      await options.handle("event", { authority: input.authority, message: { type: "assistant", agent_id: "native-session", run_id: "native-run", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } } });
      return { agentId: "native-session", id: "native-run", status: "finished" };
    });
    return { channel: { request }, close, child: Object.assign(new ChildProcess(), { stdio: [], exitCode: 0 }) } as unknown as Awaited<ReturnType<typeof openCursorSdkWorker>>;
  });
  const input = nativeProviderRunInput({ providerId: "cursor", harnessId: "cursor-sdk", conversationId: "chat", cwd: root,
    prompt: "hello", model: "synthetic-model", interactionMode: "build", access: "supervised" });
  const options: AgentHarnessStartOptions = { input, executable: "unused-cli", environment: {}, providerNativeToolsAvailable: true,
    cursorSdk: { stateRoot: join(root, "providers"), credentials: { resolve: async () => "synthetic-test-token", status: async () => ({ hasSecret: true, credentialGeneration: "generation" }) } },
    callbacks: { onEvent: (event: AgentHarnessEvent) => events.push(event) } };
  return { start: () => startCursorSdkRun(options, { openWorker }), options, events, request, close, openWorker };
}

describe("Cursor SDK production harness", () => {
  it("launches exact authority with explicit private credentials, read-only native tools and joined cleanup", async () => {
    const f = await fixture(); const result = await f.start().result;
    expect(result).toMatchObject({ status: "completed", sessionId: "native-session", text: "Done", cleanupConfirmed: true });
    expect(f.request).toHaveBeenCalledWith("start", expect.objectContaining({ apiKey: "synthetic-test-token", nativeTools: "read",
      authority: expect.objectContaining({ conversationId: f.options.input.conversationId, runId: f.options.input.runId, turnId: f.options.input.turnId, workspace: f.options.input.cwd }) }), 1800000);
    expect(f.close).toHaveBeenCalledOnce(); expect(JSON.stringify(f.events)).not.toContain("synthetic-test-token");
  });
  it("rejects foreign application event authority", async () => {
    const f = await fixture(async (input, handle) => {
      await handle("event", { authority: { ...input.authority, turnId: "foreign" }, message: { type: "status", agent_id: "native", run_id: "run" } });
      return { id: "run", status: "finished" };
    });
    expect(await f.start().result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("rejects malformed output", async () => {
    const f = await fixture(async (input, handle) => {
      await handle("event", { authority: input.authority, message: { type: "assistant", agent_id: "native", run_id: "run", message: "invalid" } });
      return {};
    });
    expect(await f.start().result).toMatchObject({ status: "failed" });
  });
  it("does not claim cleanup when tree termination fails", async () => {
    const f = await fixture(); f.close.mockRejectedValue(new Error("cleanup failed"));
    expect(await f.start().result).toMatchObject({ cleanupConfirmed: false });
  });
  it("cancels before launch without starting a worker", async () => {
    const f = await fixture(); const run = f.start(); run.cancel(true);
    expect(await run.result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    expect(f.openWorker).not.toHaveBeenCalled();
  });
  it("rejects host tool calls without exact turn authority", async () => {
    const f = await fixture(async (input, handle) => {
      await handle("host-tool", { authority: { ...input.authority, runId: "foreign" }, callId: randomUUID(), tool: "test", arguments: {} }); return {};
    });
    expect(await f.start().result).toMatchObject({ status: "failed" });
  });
  it("routes host calls through exact app authority and rejects replays", async () => {
    const f = await fixture(async (input, handle) => {
      const call = { authority: input.authority, callId: randomUUID(), tool: "test", arguments: { value: "ok" } };
      expect(await handle("host-tool", call)).toMatchObject({ isError: false });
      expect(await handle("host-tool", call)).toMatchObject({ isError: true });
      return { agentId: "native-session", id: "native-run", status: "finished" };
    });
    const invoke = vi.fn(async () => ({ success: true, text: "result" }));
    f.options.hostTools = { definitions: [{ name: "test", description: "Test", inputSchema: { type: "object" }, readOnly: true }], invoke };
    expect(await f.start().result).toMatchObject({ status: "completed" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ providerThreadId: f.options.input.conversationId, providerTurnId: f.options.input.turnId }));
  });

  it("preserves active steering disposition and waits for turn settlement", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const f = await fixture(async () => { await waiting; return { agentId: "native-session", id: "native-run", status: "finished" }; });
    const run = f.start();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("start", expect.anything(), 1800000));
    if (run.extension.kind !== "cursor-sdk") throw new Error("wrong route");
    await expect(run.extension.steer!({ content: "next", imagePaths: [] })).resolves.toBe(false);
    finish(); await expect(run.result).resolves.toMatchObject({ status: "completed" });
  });

});
