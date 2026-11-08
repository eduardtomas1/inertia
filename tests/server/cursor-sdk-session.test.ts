import { describe, expect, it, vi } from "vitest";
import type { LocalAgentStore, Run, SDKAgent, SDKMessage } from "@cursor/sdk";
import { CursorSdkSession } from "../../src/server/provider/cursor-sdk-session";

const authority = { conversationId: "conversation", turnId: "turn", runId: "application-run", providerInstanceId: "instance", workspace: "/workspace" };
function fixture(messages: SDKMessage[] = []) {
  const run = { id: "native-run", agentId: "agent", stream: async function* () { yield* messages; },
    wait: vi.fn(async () => ({ id: "native-run", status: "finished" })), cancel: vi.fn(async () => undefined),
    steer: vi.fn(async () => "complete_delivered") } as unknown as Run;
  const agent = { agentId: "agent", send: vi.fn(async () => run), close: vi.fn() } as unknown as SDKAgent;
  const store = { agents: { get: vi.fn(async () => ({ agentId: "agent", cwd: "/workspace", status: "idle" })) },
    runs: { get: vi.fn(async () => ({ agentId: "agent", runId: "native-run", status: "finished" })) } } as unknown as LocalAgentStore;
  const dependencies = { create: vi.fn(async () => agent), resume: vi.fn(async () => agent), store,
    assertAuthority: vi.fn(), emit: vi.fn(async () => undefined) };
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
    expect(f.dependencies.resume).toHaveBeenCalledWith("agent", expect.objectContaining({ tools: [] }));
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
