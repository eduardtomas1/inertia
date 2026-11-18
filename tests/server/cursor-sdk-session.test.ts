import { describe, expect, it, vi } from "vitest";
import type { LocalAgentStore, Run, SDKAgent, SDKMessage } from "@cursor/sdk";
import { CursorSdkSession, resumeCursorSdkAgent } from "../../src/server/provider/cursor-sdk-session";
import { CursorSdkStoreRecords } from "../../src/server/provider/cursor-sdk-store-records";
import { cursorSdkStorePlan } from "../../src/server/provider/cursor-sdk-store-plan";
import { cursorSdkStartSchema } from "../../src/node/cursor-sdk-protocol";

const authority = { conversationId: "conversation", turnId: "turn", runId: "application-run", providerInstanceId: "instance", workspace: "/workspace" };
function fixture(messages: SDKMessage[] = [], moved?: { storeWorkspace: string; agentCwd: string }) {
  const run = { id: "native-run", agentId: "agent", stream: async function* () { yield* messages; },
    wait: vi.fn(async () => ({ id: "native-run", status: "finished" })), cancel: vi.fn(async () => undefined),
    steer: vi.fn(async () => "complete_delivered") } as unknown as Run;
  const agent = { agentId: "agent", send: vi.fn(async () => run), close: vi.fn() } as unknown as SDKAgent;
  const store = { agents: { get: vi.fn(async () => ({ agentId: "agent", cwd: moved?.agentCwd ?? "/workspace", status: "idle" })) },
    runs: { get: vi.fn(async () => ({ agentId: "agent", runId: "native-run", status: "finished" })) } } as unknown as LocalAgentStore;
  const dependencies = { create: vi.fn(async () => agent), resume: vi.fn(async () => agent), store,
    assertAuthority: vi.fn(), emit: vi.fn(async () => undefined), ...(moved ? { storeWorkspace: moved.storeWorkspace } : {}) };
  return { session: new CursorSdkSession(authority, dependencies), dependencies, agent, run, store };
}
const text = (value: string): SDKMessage => ({ type: "thinking", agent_id: "agent", run_id: "native-run", text: value });

describe("Cursor SDK session boundary", () => {
  it("requires matching durable terminal evidence and explicit restricted options", async () => {
    const f = fixture([text("answer")]);
    await expect(f.session.execute("synthetic-test-token", "hello")).resolves.toEqual({ id: "native-run", status: "finished" });
    expect(f.dependencies.create).toHaveBeenCalledWith({ apiKey: "synthetic-test-token", tools: [],
      local: { cwd: "/workspace", store: f.store, settingSources: [], enableAgentRetries: false } });
    expect(f.dependencies.emit).toHaveBeenCalledOnce();
    expect(f.agent.close).toHaveBeenCalledOnce();
    await expect(f.session.execute("synthetic-test-token", "again")).rejects.toThrow("unavailable");
  });
  it("reapplies restrictions on exact resume", async () => {
    const f = fixture();
    await f.session.execute("synthetic-test-token", "hello", "agent");
    expect(f.dependencies.create).not.toHaveBeenCalled();
    expect(f.dependencies.resume).toHaveBeenCalledWith("agent", expect.objectContaining({ tools: [] }), undefined);
  });
  it("resumes an agent created in the checkout the chat moved from and runs it here", async () => {
    const f = fixture([], { storeWorkspace: "/original", agentCwd: "/original" });
    await expect(f.session.execute("synthetic-test-token", "hello", "agent")).resolves.toEqual({ id: "native-run", status: "finished" });
    expect(f.dependencies.resume).toHaveBeenCalledWith("agent",
      expect.objectContaining({ local: expect.objectContaining({ cwd: "/workspace", store: f.store }) }), "/original");
  });
  it("resumes from another checkout's store only an agent that store recorded for that checkout", async () => {
    for (const moved of [{ storeWorkspace: "/original", agentCwd: "/workspace" }, { storeWorkspace: "/original", agentCwd: "/third" }]) {
      const f = fixture([], moved);
      await expect(f.session.execute("synthetic-test-token", "hello", "agent")).rejects.toThrow("verified");
      expect(f.dependencies.resume).not.toHaveBeenCalled();
    }
    for (const [storeWorkspace, sessionId] of [["/original", undefined], ["/workspace", "agent"]] as const) {
      const f = fixture([], { storeWorkspace, agentCwd: storeWorkspace });
      await expect(f.session.execute("synthetic-test-token", "hello", sessionId)).rejects.toThrow("store workspace");
      expect(f.dependencies.create).not.toHaveBeenCalled(); expect(f.dependencies.resume).not.toHaveBeenCalled();
    }
  });
  it("does not replace a missing native session", async () => {
    const f = fixture(); vi.mocked(f.store.agents.get).mockResolvedValue(null);
    await expect(f.session.execute("synthetic-test-token", "hello", "agent")).rejects.toThrow("verified");
    expect(f.dependencies.resume).not.toHaveBeenCalled(); expect(f.dependencies.create).not.toHaveBeenCalled();
  });
  it("rejects foreign events before emission and cancels", async () => {
    const f = fixture([{ ...text("foreign"), run_id: "other" }]);
    await expect(f.session.execute("synthetic-test-token", "hello")).rejects.toThrow("verified");
    expect(f.dependencies.emit).not.toHaveBeenCalled(); expect(f.run.cancel).toHaveBeenCalledOnce();
  });
  it("bounds provider output", async () => {
    const f = fixture([text("x".repeat(1024 * 1024))]);
    await expect(f.session.execute("synthetic-test-token", "hello")).rejects.toThrow("verified");
    expect(f.run.cancel).toHaveBeenCalledOnce();
  });
  it("does not accept stream completion without store evidence", async () => {
    const f = fixture(); vi.mocked(f.store.runs.get).mockResolvedValue(null);
    await expect(f.session.execute("synthetic-test-token", "hello")).rejects.toThrow("verified");
    expect(f.run.cancel).toHaveBeenCalledOnce();
  });
  it("does not execute after cancellation or authority revocation", async () => {
    const f = fixture(); await f.session.cancel();
    await expect(f.session.execute("synthetic-test-token", "hello")).rejects.toThrow("active");
    expect(f.dependencies.create).not.toHaveBeenCalled();
    const other = fixture(); other.dependencies.assertAuthority.mockImplementation(() => { throw new Error("revoked"); });
    await expect(other.session.execute("synthetic-test-token", "hello")).rejects.toThrow("revoked");
    expect(other.dependencies.create).not.toHaveBeenCalled();
  });
  it("preserves follow-up steering dispositions", async () => {
    const f = fixture([text("running")]);
    vi.mocked(f.run.steer!).mockResolvedValue("revert_to_followup");
    f.dependencies.emit.mockImplementation(async () => {
      await expect(f.session.steer("more")).resolves.toBe("revert_to_followup");
    });
    await f.session.execute("synthetic-test-token", "hello");
  });
});

describe("Cursor SDK store lookup across checkouts (installed @cursor/sdk)", () => {
  async function storeWithAgent(storeCwd: string) {
    const sdk = await import("@cursor/sdk");
    const persisted: unknown[] = [];
    const store = new CursorSdkStoreRecords(() => undefined, (mutation) => { persisted.push(mutation); }, async () => undefined);
    const platform = await sdk.createAgentPlatform({ localStore: store, workspaceRef: storeCwd });
    const { agent } = await platform.store.createAgent({ agentId: "agent-moved", workspaceRef: storeCwd });
    return { sdk, store, agent, persisted };
  }
  it("finds an agent only through a platform scoped to the checkout that created it", async () => {
    const { sdk, store, agent } = await storeWithAgent("/checkouts/original");
    const here = { apiKey: "synthetic-test-token", local: { cwd: "/checkouts/moved", store } };
    // Cursor scopes custom-store reads to `local.cwd`: a plain resume in the new checkout cannot see the agent.
    await expect(sdk.Agent.resume(agent.agentId, here)).rejects.toThrow("not found");
    await expect(resumeCursorSdkAgent(sdk, agent.agentId, here, "/checkouts/third")).rejects.toThrow("not found");
    const resumed = await resumeCursorSdkAgent(sdk, agent.agentId, here, "/checkouts/original");
    try {
      expect(resumed.agentId).toBe(agent.agentId);
      // Resuming does not rewrite where the store keeps the agent.
      expect(await store.agents.get({ agentId: agent.agentId })).toMatchObject({ cwd: "/checkouts/original" });
    } finally { resumed.close(); }
  });
  it("keeps the plain resume when the agent was created in this checkout", async () => {
    const { sdk, store, agent } = await storeWithAgent("/checkouts/original");
    const resume = vi.spyOn(sdk.Agent, "resume");
    const observed = { Agent: sdk.Agent, createAgentPlatform: vi.fn(sdk.createAgentPlatform) };
    const options = { apiKey: "synthetic-test-token", local: { cwd: "/checkouts/original", store } };
    for (const storeWorkspace of [undefined, "/checkouts/original"]) {
      const resumed = await resumeCursorSdkAgent(observed, agent.agentId, options, storeWorkspace);
      resumed.close();
    }
    expect(resume).toHaveBeenCalledTimes(2); expect(observed.createAgentPlatform).not.toHaveBeenCalled();
    await expect(resumeCursorSdkAgent(observed, agent.agentId, { apiKey: "synthetic-test-token", local: { cwd: "/elsewhere" } }, "/checkouts/original"))
      .rejects.toThrow("requires its store");
  });
});

/** The state a finished run leaves: every run terminal, the agent idle without an active run. */
async function settle(store: CursorSdkStoreRecords, agentId: string) {
  for (const run of (await store.runs.list({ filter: { agentIds: [agentId] } })).items) {
    await store.runs.update({ run: { ...run, status: "finished" } });
  }
  const agent = (await store.agents.get({ agentId }))!;
  await store.agents.update({ agent: { ...agent, status: "idle", activeRunId: null } });
}

describe("Cursor SDK agents handed to parallel worktrees", () => {
  it("refuses to copy an agent its store holds mid-run, so a later turn copies it once settled", async () => {
    const sdk = await import("@cursor/sdk");
    const origin = "/checkouts/project-root";
    const checkout = new CursorSdkStoreRecords(() => undefined, () => undefined, async () => undefined);
    const platform = await sdk.createAgentPlatform({ localStore: checkout, workspaceRef: origin });
    const { run } = await platform.store.createAgent({ agentId: "agent-busy", workspaceRef: origin });
    // As the SDK leaves it between its run's and its own terminal write, and while a run is open.
    expect(() => checkout.exportAgent("agent-busy")).toThrow("not settled");
    const agent = (await checkout.agents.get({ agentId: "agent-busy" }))!;
    await checkout.agents.update({ agent: { ...agent, status: "idle", activeRunId: null } });
    expect(() => checkout.exportAgent("agent-busy")).toThrow("not settled");
    await checkout.runs.update({ run: { ...(await checkout.runs.get({ agentId: "agent-busy", runId: run.runId }))!, status: "finished" } });
    await checkout.agents.update({ agent: { ...agent, status: "running", activeRunId: null } });
    expect(() => checkout.exportAgent("agent-busy")).toThrow("not settled");
    await settle(checkout, "agent-busy");
    expect(checkout.exportAgent("agent-busy").at(-1)).toMatchObject({ table: "agents", value: { status: "idle", activeRunId: null } });
  });

  it("adopts a moved agent into its own store once, and keeps using that store wherever the chat runs", () => {
    const plan = (input: Partial<Parameters<typeof cursorSdkStorePlan>[0]>) => cursorSdkStorePlan({ resumed: true, moved: false,
      agentJournal: false, originStore: false, ...input });
    expect(plan({ resumed: false, moved: true, agentJournal: true })).toBe("checkout");
    expect(plan({})).toBe("checkout");
    expect(plan({ moved: true, originStore: true })).toBe("adopt");
    expect(plan({ moved: true, agentJournal: true, originStore: true })).toBe("agent");
    // Back in its original checkout, an adopted agent stays in its own store; the checkout's copy is stale.
    expect(plan({ agentJournal: true })).toBe("agent");
    expect(plan({ moved: true })).toBe("unavailable");
  });

  it("gives each agent of a shared checkout store its own complete store, leaving the checkout store as it was", async () => {
    const sdk = await import("@cursor/sdk");
    const origin = "/checkouts/project-root";
    const checkout = new CursorSdkStoreRecords(() => undefined, () => undefined, async () => undefined);
    const platform = await sdk.createAgentPlatform({ localStore: checkout, workspaceRef: origin });
    for (const agentId of ["agent-one", "agent-two"]) {
      const { run } = await platform.store.createAgent({ agentId, workspaceRef: origin });
      await checkout.checkpoints.create({ agentId, blobId: `${agentId}-blob`, data: Buffer.from(agentId) });
      await checkout.runEvents.append({ runId: run.runId, eventType: "note", payload: { agentId } });
      await settle(checkout, agentId);
    }
    const before = JSON.stringify(checkout.exportAgent("agent-one")) + JSON.stringify(checkout.exportAgent("agent-two"));
    const adopted = new Map<string, CursorSdkStoreRecords>();
    for (const [agentId, worktree] of [["agent-one", "/checkouts/worktree-b"], ["agent-two", "/checkouts/worktree-c"]] as const) {
      const own = new CursorSdkStoreRecords(() => undefined, () => undefined, async () => undefined);
      const mutations = checkout.exportAgent(agentId);
      expect(mutations.at(-1)).toMatchObject({ table: "agents", value: { agentId, cwd: origin } });
      for (const mutation of mutations) own.replay(mutation);
      adopted.set(agentId, own);
      expect((await own.agents.list()).items.map((agent) => agent.agentId)).toEqual([agentId]);
      expect(await own.checkpoints.get({ agentId, blobId: `${agentId}-blob` })).toEqual(Buffer.from(agentId));
      const runs = (await own.runs.list({ filter: { agentIds: [agentId] } })).items;
      expect(runs).toHaveLength(1);
      expect((await own.runEvents.list({ runId: runs[0]!.runId })).items).toEqual((await checkout.runEvents.list({ runId: runs[0]!.runId })).items);
      // The agent runs in its worktree from its own store; nothing else holds that store.
      const resumed = await resumeCursorSdkAgent(sdk, agentId, { apiKey: "synthetic-test-token", local: { cwd: worktree, store: own } }, origin);
      expect(resumed.agentId).toBe(agentId); resumed.close();
    }
    expect(JSON.stringify(checkout.exportAgent("agent-one")) + JSON.stringify(checkout.exportAgent("agent-two"))).toBe(before);
    expect(() => adopted.get("agent-one")!.exportAgent("agent-two")).toThrow("not in this store");
  });
});

describe("Cursor SDK worker start boundary", () => {
  it("accepts store paths only in their exact combinations", () => {
    const base = { authority: { conversationId: "c", turnId: "t", runId: "r", providerInstanceId: "i", workspace: "/moved" },
      apiKey: "synthetic-test-token", stateRoot: "/state/agent", prompt: "hello", sessionId: "agent", model: "model",
      nativeTools: "none" as const, tools: [], storeWorkspace: "/origin", agentStateRoot: "/state/agent", adoptFrom: "/state/origin" };
    expect(cursorSdkStartSchema.safeParse(base).success).toBe(true);
    for (const change of [{ adoptFrom: "/state/agent" }, { agentStateRoot: "/state/a\0gent" }, { adoptFrom: "/state/o\0rigin" },
      { agentStateRoot: "x".repeat(4097) }, { storeWorkspace: undefined }, { sessionId: undefined }]) {
      expect(cursorSdkStartSchema.safeParse({ ...base, ...change }).success).toBe(false);
    }
  });
});
