import { afterEach, describe, expect, it, vi } from "vitest";
import { runRuntimeShutdownPhases, type RuntimeShutdownPhases } from "../../src/server/runtime-shutdown";

afterEach(() => { vi.useRealTimers(); });

function fixture() {
  const calls: string[] = [];
  let release!: () => void;
  const command = new Promise<void>((resolve) => { release = resolve; });
  const phases: RuntimeShutdownPhases = {
    quiesceRuntimeWork: () => command,
    independentDrains: [() => { calls.push("terminal"); }],
    stopIsolatedRuns: () => { calls.push("isolated"); },
    disposeTurnsAndProviders: () => { calls.push("providers"); },
    settleArtifacts: () => { calls.push("artifacts"); },
    terminateClients: () => { calls.push("clients"); },
    closeServer: () => { calls.push("server"); },
    closeStore: () => { calls.push("store"); },
  };
  return { calls, release, phases };
}

describe("shutdown after incomplete command quiescence", () => {
  it("attempts owned cancellation within the original deadline and retains active command authority", async () => {
    vi.useFakeTimers();
    const { calls, release, phases } = fixture();
    const rejected = expect(runRuntimeShutdownPhases(phases, 100)).rejects.toMatchObject({ phase: "runtime command cleanup" });
    await vi.advanceTimersByTimeAsync(50);
    const callsBeforeDeadline = [...calls];
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(callsBeforeDeadline).toEqual(["terminal", "isolated", "providers"]);
    expect(calls).toEqual(["terminal", "isolated", "providers"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).not.toContain("store");
  });

  it("allows cancellation to unblock quiescence before settling artifacts and closing the store", async () => {
    vi.useFakeTimers();
    const { calls, release, phases } = fixture();
    phases.independentDrains = [() => { calls.push("terminal"); release(); }];
    const completed = expect(runRuntimeShutdownPhases(phases, 100)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    await completed;
    expect(calls).toEqual(["terminal", "isolated", "providers", "artifacts", "clients", "server", "store"]);
  });

  it("still attempts owned cancellation after a quiescence error without closing storage", async () => {
    const { calls, phases } = fixture();
    const error = new Error("Command drain failed before proving quiescence");
    phases.quiesceRuntimeWork = () => { throw error; };
    await expect(runRuntimeShutdownPhases(phases)).rejects.toBe(error);
    expect(calls).toEqual(["terminal", "isolated", "providers"]);
  });

  it.each(["quiesce", "owned"] as const)("preserves even undefined %s failure as rejected cleanup", async (phase) => {
    const { calls, release, phases } = fixture();
    release();
    if (phase === "quiesce") phases.quiesceRuntimeWork = () => Promise.reject(undefined);
    else phases.independentDrains = [() => Promise.reject(undefined)];
    await expect(runRuntimeShutdownPhases(phases)).rejects.toBeUndefined();
    expect(calls).not.toContain("store");
    expect(calls).toContain("providers");
  });
});
