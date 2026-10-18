import { describe, expect, it } from "vitest";

import { RuntimeUpdatePreparationGate } from "../../src/server/runtime-update-preparation";

function gate(work: { turns?: boolean; runs?: boolean; terminals?: boolean; recovery?: boolean; maintenance?: boolean; refresh?: boolean } = {}) {
  return new RuntimeUpdatePreparationGate({
    isClosed: () => false, activeRuntimeCommands: () => 0, databaseRecoveryActive: () => work.recovery ?? false,
    agentWorkActive: (ignoringTurns) => (!ignoringTurns && (work.turns ?? false)) || (work.runs ?? false),
    terminalActivity: () => work.terminals ?? false, providerMaintenanceActive: () => work.maintenance ?? false,
    providerRefreshActive: () => work.refresh ?? false, artifactReconciliationActive: () => false,
    holdTerminalAdmission: () => undefined, releaseTerminalAdmission: () => undefined, drainAdditionalOperations: async () => undefined,
  });
}

describe("runtime update preparation restart blockers besides agent turns", () => {
  it("ignores running chats, which an update run stops itself", async () => {
    const subject = gate({ turns: true, maintenance: true });
    expect(subject.restartBlockerBesidesAgentTurns()).toBeNull();
    await expect(subject.prepare("operation")).resolves.toEqual({ ready: false, blocker: "agent-work" });
  });

  it.each([
    [{ recovery: true, runs: true, terminals: true }, "database-recovery"],
    [{ runs: true, terminals: true }, "agent-work"],
    [{ terminals: true }, "terminal"],
  ] as const)("reports work that would still refuse the restart", async (work, blocker) => {
    const subject = gate({ ...work, turns: true });
    expect(subject.restartBlockerBesidesAgentTurns()).toBe(blocker);
    await expect(subject.prepare("operation")).resolves.toEqual({ ready: false, blocker: blocker === "terminal" ? "agent-work" : blocker });
  });
});

describe("runtime update preparation provider activity", () => {
  it.each([
    [{ maintenance: true, refresh: true }, "provider-maintenance"],
    [{ refresh: true }, "provider-refresh"],
    [{}, null],
  ] as const)("reports provider work that would refuse the restart", async (work, blocker) => {
    const subject = gate(work);
    expect(subject.providerActivityBlocker()).toBe(blocker);
    await expect(subject.prepare("operation")).resolves.toEqual(blocker ? { ready: false, blocker } : { ready: true });
  });
});
