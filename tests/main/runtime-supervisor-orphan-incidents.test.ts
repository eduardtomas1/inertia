import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticIncident } from "../../src/shared/application-diagnostics";
import type { LinuxGuardianOrphan } from "../../src/node/runtime-owned-process-linux-orphans";

const recovery = vi.hoisted(() => ({
  owned: [] as Array<{ onUnsignalledOrphans?: (orphans: readonly LinuxGuardianOrphan[]) => void }>,
  prior: [] as Array<{ onUnsignalledOrphans?: (orphans: readonly LinuxGuardianOrphan[]) => void }>,
}));

vi.mock("../../src/main/runtime-owned-process-recovery", () => ({
  recoverRuntimeOwnedProcesses: (
    _dataDirectory: string,
    _runtimeGenerationId: string,
    _systemBootId: string,
    options: { onUnsignalledOrphans?: (orphans: readonly LinuxGuardianOrphan[]) => void },
  ) => {
    recovery.owned.push(options);
    return true;
  },
  recoverPriorRuntimeGenerations: (
    options: { onUnsignalledOrphans?: (orphans: readonly LinuxGuardianOrphan[]) => void },
  ) => {
    recovery.prior.push(options);
    return Promise.resolve(true);
  },
}));

const {
  createRuntimeSupervisorProcessSafety,
  reportUnsignalledOrphans,
} = await import("../../src/main/runtime-supervisor-process-safety");

const FIRST_GENERATION = "61000000-0000-4000-8000-000000000061:1";
const SECOND_GENERATION = "61000000-0000-4000-8000-000000000061:2";
const roots: string[] = [];

afterEach(() => {
  recovery.owned.length = 0;
  recovery.prior.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function procRoot(uids: Record<number, number>): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-orphan-proc-"));
  roots.push(root);
  for (const [pid, uid] of Object.entries(uids)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "status"), `Name:\tagent\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  }
  return root;
}

function orphan(pid: number): LinuxGuardianOrphan {
  return { pid, startTimeTicks: "100", command: "agent" };
}

describe("unsignalled orphan incidents", () => {
  it("records one quarantine incident for orphans the recovery could not signal", () => {
    const incidents: DiagnosticIncident[] = [];
    reportUnsignalledOrphans(
      (incident) => { incidents.push(incident); },
      FIRST_GENERATION,
      procRoot({ 4100: 1000, 4101: 1000 }),
    )([orphan(4100), orphan(4101)]);

    expect(incidents).toEqual([expect.objectContaining({
      code: "runtime.process-quarantined",
      outcome: "unknown",
      runtimeGeneration: FIRST_GENERATION,
    })]);
  });

  it("records a root process incident when an unsignalled orphan is root-owned", () => {
    const incidents: DiagnosticIncident[] = [];
    reportUnsignalledOrphans(
      (incident) => { incidents.push(incident); },
      null,
      procRoot({ 4200: 1000, 4201: 0 }),
    )([orphan(4200), orphan(4201)]);

    expect(incidents).toEqual([expect.objectContaining({
      code: "runtime.root-process-running",
      runtimeGeneration: null,
    })]);
  });

  it("wires every supervisor recovery to the incident sink", async () => {
    const incidents: DiagnosticIncident[] = [];
    const dataDirectory = mkdtempSync(join(tmpdir(), "inertia-orphan-supervisor-"));
    roots.push(dataDirectory);
    const safety = createRuntimeSupervisorProcessSafety({
      configuration: {
        workerOptions: { dataDirectory },
        onIncident: (incident: DiagnosticIncident) => { incidents.push(incident); },
      } as never,
      systemBootId: "boot-1",
      forceKillWaitMs: 1_000,
      leases: {} as never,
      ownedProcesses: {} as never,
      receipts: {} as never,
    });

    void safety.recoverOwnedProcesses(SECOND_GENERATION, "boot-1", Date.now() + 1_000);
    await safety.startupRecovery.begin(() => undefined);
    recovery.owned[0]?.onUnsignalledOrphans?.([orphan(999_999_999)]);
    recovery.prior[0]?.onUnsignalledOrphans?.([orphan(999_999_998)]);

    expect(incidents).toEqual([
      expect.objectContaining({ code: "runtime.process-quarantined", runtimeGeneration: SECOND_GENERATION }),
      expect.objectContaining({ code: "runtime.process-quarantined", runtimeGeneration: null }),
    ]);
  });
});
