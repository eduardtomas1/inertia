import { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, afterEach, vi } from "vitest";
import { startCursorSdkRun } from "../../src/server/provider/cursor-sdk-harness";
import { ProviderSteerDeliveryUnknownError } from "../../src/server/provider/contracts";
import { CursorSdkSession, CursorSteerRefusedError } from "../../src/server/provider/cursor-sdk-session";
import { CursorSdkStoreMissingError } from "../../src/server/provider/cursor-sdk-store";
import type { openCursorSdkWorker } from "../../src/server/provider/cursor-sdk-process";
import type { CursorSdkStart } from "../../src/node/cursor-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";
import type { AgentHarnessEvent, AgentHarnessStartOptions } from "../../src/server/provider/agent-harness";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });
async function fixture(body?: (input: CursorSdkStart, handle: Parameters<typeof openCursorSdkWorker>[0]["handle"], signal: AbortSignal) => Promise<unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-sdk-harness-"))); roots.push(root);
  const store = join(root, "store");
  const originStores = { missing: new Set<string>(), broken: new Set<string>() };
  const resolveStateRoot = vi.fn(async (_configuration: unknown, workspace: string, _instance: string, existing?: boolean) => {
    if (existing && originStores.missing.has(workspace)) throw new CursorSdkStoreMissingError();
    if (existing && originStores.broken.has(workspace)) throw new Error("EACCES");
    if (existing) return `${workspace}#origin-store`;
    await mkdir(store, { recursive: true }); return await realpath(store);
  });
  /** Agent id → whether its own store holds a journal. */
  const agentStores = new Map<string, boolean>();
  const resolveAgentStateRoot = vi.fn(async (_configuration: unknown, _instance: string, agentId: string, create: boolean) => {
    if (create && !agentStores.has(agentId)) agentStores.set(agentId, false);
    return agentStores.has(agentId) ? { directory: `${root}/agent-store-${agentId}`, journal: agentStores.get(agentId)! } : null;
  });
  const resolveSecret = vi.fn(async () => "synthetic-test-token");
  const events: AgentHarnessEvent[] = [];
  const close = vi.fn(async () => undefined);
  const request = vi.fn(async (_method: string, _params: unknown, _timeout?: number) => null as unknown);
  const openWorker = vi.fn(async (options: Parameters<typeof openCursorSdkWorker>[0]) => {
    request.mockImplementation(async (method?: unknown, value?: unknown) => {
      if (method !== "start") return "revert_to_followup";
      const input = value as CursorSdkStart;
      if (body) return body(input, options.handle, options.signal);
      await options.handle("event", { authority: input.authority, message: { type: "assistant", agent_id: "native-session", run_id: "native-run", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } } });
      return { agentId: "native-session", id: "native-run", status: "finished" };
    });
    return { channel: { request }, close, child: Object.assign(new ChildProcess(), { stdio: [], exitCode: 0 }) } as unknown as Awaited<ReturnType<typeof openCursorSdkWorker>>;
  });
  const input = nativeProviderRunInput({ providerId: "cursor", harnessId: "cursor-sdk", conversationId: "chat", cwd: root,
    prompt: "hello", model: "synthetic-model", interactionMode: "build", access: "supervised" });
  const options: AgentHarnessStartOptions = { input, executable: "unused-cli", environment: {}, providerNativeToolsAvailable: true,
    cursorSdk: { stateRoot: join(root, "providers"), credentials: { resolve: resolveSecret, status: async () => ({ hasSecret: true, credentialGeneration: "generation" }) } },
    callbacks: { onEvent: (event: AgentHarnessEvent) => events.push(event) } };
  return { start: () => startCursorSdkRun(options, { openWorker, resolveStateRoot, resolveAgentStateRoot }),
    startWithDefaultStorage: () => startCursorSdkRun(options, { openWorker }),
    options, events, request, close, openWorker, store, resolveStateRoot, resolveAgentStateRoot, agentStores, originStores, resolveSecret };
}

describe("Cursor SDK production harness", () => {
  it("launches exact authority with explicit private credentials, read-only native tools and joined cleanup", async () => {
    const f = await fixture(); const result = await f.start().result;
    expect(result).toMatchObject({ status: "completed", sessionId: "native-session", text: "Done", cleanupConfirmed: true });
    expect(f.resolveStateRoot).toHaveBeenCalledWith(f.options.cursorSdk, f.options.input.cwd, expect.any(String));
    expect(f.request).toHaveBeenCalledWith("start", expect.objectContaining({ apiKey: "synthetic-test-token", nativeTools: "read", stateRoot: f.store,
      authority: expect.objectContaining({ conversationId: f.options.input.conversationId, runId: f.options.input.runId, turnId: f.options.input.turnId, workspace: f.options.input.cwd }) }), 1800000);
    expect(f.close).toHaveBeenCalledOnce(); expect(JSON.stringify(f.events)).not.toContain("synthetic-test-token");
  });
  it("runs a moved chat's agent from its own store, adopted from the store of the checkout it was created in", async () => {
    const f = await fixture();
    const origin = join(f.options.input.cwd, "removed-original-checkout");
    f.options.input = { ...f.options.input, sessionId: "native-session", sessionOriginCwd: origin };
    expect(await f.start().result).toMatchObject({ status: "completed", sessionId: "native-session" });
    // The original checkout is a recorded key: it may be gone, and its store is looked up, never created.
    expect(f.resolveStateRoot).toHaveBeenCalledWith(f.options.cursorSdk, origin, expect.any(String), true);
    expect(f.resolveAgentStateRoot.mock.calls.map(([, , agentId, create]) => [agentId, create]))
      .toEqual([["native-session", false], ["native-session", true]]);
    const agentStore = `${f.options.input.cwd}/agent-store-native-session`;
    const start = f.request.mock.calls.find(([method]) => method === "start")![1] as CursorSdkStart;
    expect(start).toMatchObject({ sessionId: "native-session", storeWorkspace: origin, stateRoot: agentStore,
      agentStateRoot: agentStore, adoptFrom: `${origin}#origin-store`, authority: expect.objectContaining({ workspace: f.options.input.cwd }) });
    // An adopted agent no longer needs its original store.
    f.agentStores.set("native-session", true); f.request.mockClear(); f.resolveStateRoot.mockClear();
    await f.start().result;
    expect(f.resolveStateRoot).not.toHaveBeenCalledWith(f.options.cursorSdk, origin, expect.any(String), true);
    const again = f.request.mock.calls.find(([method]) => method === "start")![1] as CursorSdkStart;
    expect(again).toMatchObject({ agentStateRoot: agentStore, storeWorkspace: origin });
    expect(again).not.toHaveProperty("adoptFrom");
  });
  it("keeps running an adopted agent from its own store back in its original checkout, and other agents from theirs", async () => {
    const f = await fixture();
    f.agentStores.set("adopted-session", true);
    for (const [sessionId, agentStateRoot] of [["adopted-session", `${f.options.input.cwd}/agent-store-adopted-session`],
      ["local-session", undefined]] as const) {
      f.request.mockClear();
      f.options.input = { ...f.options.input, sessionId, sessionOriginCwd: undefined as unknown as string };
      await f.start().result;
      expect(f.resolveAgentStateRoot).toHaveBeenCalledWith(f.options.cursorSdk, expect.any(String), sessionId, false);
      const start = f.request.mock.calls.find(([method]) => method === "start")![1] as CursorSdkStart;
      expect(start.agentStateRoot).toBe(agentStateRoot);
      expect(start.stateRoot).toBe(agentStateRoot ?? f.store);
      expect(start).not.toHaveProperty("adoptFrom");
      expect(start).not.toHaveProperty("storeWorkspace");
    }
    expect(f.agentStores.has("local-session")).toBe(false);
  });
  it("reports a moved agent whose stores are gone unavailable before starting a worker, and fails other lookup errors as storage errors", async () => {
    for (const kind of ["missing", "broken"] as const) {
      const f = await fixture();
      const origin = join(f.options.input.cwd, "original-checkout");
      f.originStores[kind].add(origin);
      f.options.input = { ...f.options.input, sessionId: "native-session", sessionOriginCwd: origin };
      const result = await f.start().result;
      expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true });
      expect(result.failure?.sessionUnavailable).toBe(kind === "missing" ? true : undefined);
      if (kind === "broken") expect(result.error).toContain("storage is unavailable");
      expect(f.openWorker).not.toHaveBeenCalled(); expect(f.resolveSecret).not.toHaveBeenCalled();
      expect(f.agentStores.has("native-session")).toBe(false);
    }
  });
  it("ignores a session origin without a session or in the same checkout", async () => {
    for (const resumed of [false, true]) {
      const f = await fixture();
      f.options.input = { ...f.options.input, ...(resumed
        ? { sessionId: "native-session", sessionOriginCwd: f.options.input.cwd } : { sessionOriginCwd: "/elsewhere" }) };
      expect(await f.start().result).toMatchObject({ status: "completed" });
      expect(f.resolveStateRoot).toHaveBeenCalledWith(f.options.cursorSdk, f.options.input.cwd, expect.any(String));
      expect(f.request.mock.calls.find(([method]) => method === "start")![1]).not.toHaveProperty("storeWorkspace");
    }
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

  it("returns false cleanly on Cursor SDK steer refusals and keeps ProviderSteerDeliveryUnknownError for ambiguous errors", async () => {
    // 1. Session-level clean refusal when inactive or missing run.steer returns revert_to_followup instead of throwing.
    const session = new CursorSdkSession(
      { conversationId: "c", turnId: "t", runId: "r", providerInstanceId: "p", workspace: "/tmp" },
      {
        create: vi.fn(),
        resume: vi.fn(),
        store: {} as never,
        assertAuthority: vi.fn(),
        emit: vi.fn(),
      },
    );
    await expect(session.steer("not yet active")).resolves.toBe("revert_to_followup");

    // 2. Harness maps clean worker/SDK refusal errors to false without ProviderSteerDeliveryUnknownError.
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const f = await fixture(async () => { await waiting; return { agentId: "native-session", id: "native-run", status: "finished" }; });
    const run = f.start();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("start", expect.anything(), 1800000));
    if (run.extension.kind !== "cursor-sdk") throw new Error("wrong route");

    for (const cleanError of [
      new CursorSteerRefusedError(),
      new Error("No active session."),
      new Error("Cursor SDK steering is unavailable."),
    ]) {
      f.request.mockImplementationOnce(async () => { throw cleanError; });
      await expect(run.extension.steer!({ content: "clean refusal", imagePaths: [] })).resolves.toBe(false);
    }

    // 3. Ambiguous mid-flight transport/unknown failure still throws ProviderSteerDeliveryUnknownError.
    f.request.mockImplementationOnce(async () => { throw new Error("Worker pipe closed mid-request"); });
    await expect(run.extension.steer!({ content: "ambiguous", imagePaths: [] })).rejects.toBeInstanceOf(
      ProviderSteerDeliveryUnknownError,
    );

    finish();
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
  });

  it("fails closed without opening a worker when durable storage is unavailable on this platform", async () => {
    const f = await fixture();
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    if (process.platform === "linux") Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      const result = await f.startWithDefaultStorage().result;
      expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true, error: expect.stringContaining("durable storage is unavailable on this platform") });
      expect(f.events).toContainEqual(expect.objectContaining({ type: "status", status: "failed", message: result.error }));
      expect(f.openWorker).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
      expect(f.resolveSecret).not.toHaveBeenCalled(); expect(f.resolveStateRoot).not.toHaveBeenCalled();
      expect(JSON.stringify([result, f.events])).not.toContain("synthetic-test-token");
    } finally { Object.defineProperty(process, "platform", original); }
  });

});

describe("Cursor SDK turn that ends before its first checkpoint (T3 c5fa33b27)", () => {
  type Body = NonNullable<Parameters<typeof fixture>[0]>;
  const streamed = (input: CursorSdkStart, handle: Parameters<Body>[1]) => handle("event", { authority: input.authority,
    message: { type: "assistant", agent_id: "native-session", run_id: "native-run", message: { role: "assistant", content: [{ type: "text", text: "Partial" }] } } });
  /** Output streams, then the worker answers `answer` for the run. */
  const answering = (answer: Record<string, unknown>): Body => async (input, handle) => { await streamed(input, handle); return answer; };
  const failedRun = (runCheckpointed?: unknown) => ({ agentId: "native-session", id: "native-run", status: "error",
    ...(runCheckpointed === undefined ? {} : { runCheckpointed }) });
  const unverified = (runCheckpointed: unknown, identity: { agentId?: string; id?: string } = {}) => ({ unverified: true,
    agentId: identity.agentId ?? "native-session", id: identity.id ?? "native-run", runCheckpointed });
  const terminal = (events: AgentHarnessEvent[]) => events.filter((event) => event.type === "status").at(-1);

  it("reports the prompt dropped when output streamed and the run failed before Cursor saved a checkpoint", async () => {
    for (const answer of [failedRun(false), unverified(false)]) {
      const f = await fixture(answering(answer));
      const result = await f.start().result;
      expect(result).toMatchObject({ status: "failed", text: "Partial", cleanupConfirmed: true });
      expect(terminal(f.events)).toMatchObject({ status: "failed", promptDropped: true });
    }
  });

  it("reports the prompt dropped when the user stopped the run after output and the worker answered before it exited", async () => {
    let answer!: (value: unknown) => void;
    const answered = new Promise((resolve) => { answer = resolve; });
    const f = await fixture(async (input, handle) => { await streamed(input, handle); return await answered; });
    const run = f.start();
    await vi.waitFor(() => expect(f.events.some((event) => event.type === "text")).toBe(true));
    // The worker's `cancel` stops the run; its `start` then answers unverified, after closing its store.
    f.request.mockImplementation(async (method?: unknown) => { if (method === "cancel") answer(unverified(false)); return null; });
    run.cancel(false);
    expect(await run.result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    expect(terminal(f.events)).toMatchObject({ status: "cancelled", promptDropped: true });
  });

  it("reports nothing for a run the harness killed: its worker never answers", async () => {
    const f = await fixture(async (input, handle, signal) => {
      await streamed(input, handle);
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("killed")), { once: true }));
    });
    const run = f.start();
    await vi.waitFor(() => expect(f.events.some((event) => event.type === "text")).toBe(true));
    run.cancel(true);
    expect(await run.result).toMatchObject({ status: "cancelled" });
    expect(terminal(f.events)).not.toHaveProperty("promptDropped");
  });

  it("never reports a drop for a run during which Cursor summarized the conversation, as T3 does after compaction", async () => {
    const summarized: Body = async (input, handle) => {
      await streamed(input, handle);
      await handle("event", { authority: input.authority, message: { type: "task", agent_id: "native-session", run_id: "native-run", text: "Summary of the conversation so far" } });
      return unverified(false);
    };
    const f = await fixture(summarized);
    expect(await f.start().result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(terminal(f.events)).not.toHaveProperty("promptDropped");
    // The same answer without the summary is a drop.
    const plain = await fixture(answering(unverified(false)));
    await plain.start().result;
    expect(terminal(plain.events)).toMatchObject({ promptDropped: true });
  });

  it("keeps a run that checkpointed before it failed delivered", async () => {
    for (const answer of [failedRun(true), unverified(true)]) {
      const f = await fixture(answering(answer));
      expect(await f.start().result).toMatchObject({ status: "failed" });
      expect(terminal(f.events)).toMatchObject({ status: "failed" });
      expect(terminal(f.events)).not.toHaveProperty("promptDropped");
    }
  });

  it("reports nothing without a valid answer about the streamed run, after a completion, or when cleanup is unconfirmed", async () => {
    const cases: Array<{ answer: Record<string, unknown>; status: string; unconfirmed?: true }> = [
      { answer: failedRun(), status: "failed" }, // the store could not tell
      { answer: failedRun("false"), status: "failed" }, // malformed at the protocol boundary
      { answer: unverified(undefined), status: "failed" },
      { answer: { ...unverified(false), status: "error" }, status: "failed" },
      { answer: unverified(false, { id: "other-run" }), status: "failed" },
      { answer: unverified(false, { agentId: "other-agent" }), status: "failed" },
      { answer: { agentId: "native-session", id: "native-run", status: "finished", runCheckpointed: false }, status: "completed" },
      { answer: unverified(false), status: "failed", unconfirmed: true },
    ];
    for (const { answer, status, unconfirmed } of cases) {
      const f = await fixture(answering(answer));
      if (unconfirmed) f.close.mockRejectedValue(new Error("cleanup failed"));
      expect(await f.start().result).toMatchObject({ status, cleanupConfirmed: !unconfirmed });
      expect(terminal(f.events), JSON.stringify(answer)).not.toHaveProperty("promptDropped");
    }
  });
});
