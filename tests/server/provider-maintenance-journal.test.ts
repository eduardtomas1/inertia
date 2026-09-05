// @inertia-test-suite portable
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProviderInstallationLeaseCoordinator,
  providerInstallationIdentity,
} from
  "../../src/server/provider/installation-lease";
import { ProviderMaintenanceJournal } from
  "../../src/server/provider/maintenance-journal";
import {
  recoverProviderMaintenanceJournal,
  type ProviderMaintenanceRecoveryRuntime,
} from
  "../../src/server/provider/maintenance-recovery";

const roots: string[] = [];
const FIRST_GENERATION = "00000000-0000-4000-8000-000000000001:1";
const SECOND_GENERATION = "00000000-0000-4000-8000-000000000002:1";
const BOOT_ID = "test:00000000-0000-4000-8000-000000000001";

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "inertia-maintenance-journal-"));
  roots.push(value);
  return value;
}

function identity(version = "1.0.0") {
  return providerInstallationIdentity({
    providerId: "claude",
    executable: "/tools/claude",
    installationRootIdentity: null,
    packageIdentity: "@anthropic-ai/claude-code",
    version,
    environmentIdentity: "test-environment",
  });
}

function journal(
  dataDirectory: string,
  runtimeGenerationId = FIRST_GENERATION,
  testHooks?: ConstructorParameters<typeof ProviderMaintenanceJournal>[1]["testHooks"],
) {
  return new ProviderMaintenanceJournal(dataDirectory, {
    runtimeGenerationId,
    systemBootId: BOOT_ID,
    ...(testHooks ? { testHooks } : {}),
  });
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("ProviderMaintenanceJournal", () => {
  it("persists exact ownership, verification, and retirement across instances", () => {
    const dataDirectory = root();
    const owning = identity();
    const observed = identity("2.0.0");
    expect(journal(dataDirectory).begin("maintenance-1", owning)).toBe(true);

    const reopened = journal(dataDirectory);
    expect(reopened.pending()).toEqual([{
      operationId: "maintenance-1",
      installationIdentity: owning,
      runtimeGenerationId: FIRST_GENERATION,
      systemBootId: BOOT_ID,
      verifiedIdentity: null,
    }]);
    expect(reopened.markVerified("maintenance-1", observed)).toBe(true);
    expect(journal(dataDirectory).pending()[0]?.verifiedIdentity).toEqual(observed);
    expect(reopened.retireVerified("maintenance-1", observed)).toBe(true);
    expect(journal(dataDirectory).pending()).toEqual([]);
  });

  it("discards an unpublished atomic transient and rejects integrity damage", () => {
    const dataDirectory = root();
    const interrupted = journal(dataDirectory, FIRST_GENERATION, {
      afterTemporaryFileClosed: () => {
        throw new Error("simulated interruption");
      },
    });
    expect(interrupted.begin("interrupted", identity())).toBe(false);
    expect(journal(dataDirectory).pending()).toEqual([]);

    const durable = journal(dataDirectory);
    expect(durable.begin("damaged", identity())).toBe(true);
    const record = readdirSync(dataDirectory).find((name) =>
      name.startsWith(".provider-maintenance-") && name.endsWith(".json"));
    expect(record).toBeDefined();
    writeFileSync(join(dataDirectory, record!), "{}", "utf8");
    expect(() => journal(dataDirectory).pending()).toThrow(
      "record is invalid",
    );
  });

  it("does not erase ambiguous maintenance from runtime cleanup evidence alone", () => {
    const dataDirectory = root();
    const previous = journal(dataDirectory);
    expect(previous.begin("previous-runtime", identity())).toBe(true);

    const current = journal(dataDirectory, SECOND_GENERATION);
    expect(current.reconcile({
      confirmedRuntimeGenerationIds: new Set(),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    })).toHaveLength(1);
    expect(current.reconcile({
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    })).toHaveLength(1);
  });

  it("never abandons an admitted or identity-mismatched record", () => {
    const subject = journal(root());
    const owning = identity();
    expect(subject.begin("maintenance-2", owning)).toBe(true);
    expect(subject.markVerified("maintenance-2", identity("2.0.0"))).toBe(true);
    expect(subject.abandonUnadmitted("maintenance-2", owning)).toBe(false);
    expect(subject.pending()).toHaveLength(1);
  });
});

describe("provider maintenance startup recovery", () => {
  function runtime(
    verify: ProviderMaintenanceRecoveryRuntime["verifyInstallationConformance"],
  ) {
    return {
      invalidateInstallationEvidence: vi.fn(),
      verifyInstallationConformance: verify,
    };
  }

  it("quarantines without probing when prior runtime cleanup is unconfirmed", async () => {
    const dataDirectory = root();
    const owning = identity();
    expect(journal(dataDirectory).begin("unclean-runtime", owning)).toBe(true);
    const leases = new ProviderInstallationLeaseCoordinator();
    const subject = runtime(vi.fn(async () => owning));

    await expect(recoverProviderMaintenanceJournal({
      journal: journal(dataDirectory, SECOND_GENERATION),
      installationLeases: leases,
      runtime: subject,
      cwd: "/workspace",
      confirmedRuntimeGenerationIds: new Set(),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    })).resolves.toHaveLength(1);
    expect(subject.verifyInstallationConformance).not.toHaveBeenCalled();
    expect(leases.isQuarantined(owning)).toBe(true);
  });

  it("reverifies, durably retires, and reopens only after confirmed cleanup", async () => {
    const dataDirectory = root();
    const owning = identity();
    const observed = identity("2.0.0");
    expect(journal(dataDirectory).begin("recover-success", owning)).toBe(true);
    const leases = new ProviderInstallationLeaseCoordinator();
    const subject = runtime(vi.fn(async () => observed));

    await expect(recoverProviderMaintenanceJournal({
      journal: journal(dataDirectory, SECOND_GENERATION),
      installationLeases: leases,
      runtime: subject,
      cwd: "/workspace",
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    })).resolves.toEqual([]);
    expect(subject.invalidateInstallationEvidence).toHaveBeenCalledWith(
      "claude",
    );
    expect(subject.verifyInstallationConformance).toHaveBeenCalledWith(
      "claude",
      "/workspace",
      expect.objectContaining({
        operationId: "recover-success",
        boundaryId: owning.boundaryId,
      }),
    );
    const reopened = leases.acquireUse(observed, {
      kind: "provider-run",
      operationId: "run-after-recovery",
    });
    expect(reopened.release({ cleanupConfirmed: true })).toBe(true);
  });

  it("retains and quarantines failed conformance", async () => {
    const dataDirectory = root();
    const owning = identity();
    expect(journal(dataDirectory).begin("recover-failed", owning)).toBe(true);
    const leases = new ProviderInstallationLeaseCoordinator();

    await expect(recoverProviderMaintenanceJournal({
      journal: journal(dataDirectory, SECOND_GENERATION),
      installationLeases: leases,
      runtime: runtime(vi.fn(async () => {
        throw new Error("protocol handshake failed");
      })),
      cwd: "/workspace",
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    })).resolves.toHaveLength(1);
    expect(leases.isQuarantined(owning)).toBe(true);
    expect(journal(dataDirectory, SECOND_GENERATION).pending()).toHaveLength(1);
  });

  it("retains verified state when fresh conformance no longer matches it", async () => {
    const dataDirectory = root();
    const owning = identity();
    const verified = identity("2.0.0");
    expect(journal(dataDirectory).begin("recover-changed", owning)).toBe(true);
    expect(journal(dataDirectory).markVerified(
      "recover-changed",
      verified,
    )).toBe(true);
    const leases = new ProviderInstallationLeaseCoordinator();

    await expect(recoverProviderMaintenanceJournal({
      journal: journal(dataDirectory, SECOND_GENERATION),
      installationLeases: leases,
      runtime: runtime(vi.fn(async () => identity("3.0.0"))),
      cwd: "/workspace",
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    })).resolves.toHaveLength(1);
    expect(leases.isQuarantined(owning)).toBe(true);
    expect(leases.isQuarantined(verified)).toBe(true);
  });

  it("fails startup closed when durable journal integrity is corrupt", async () => {
    const dataDirectory = root();
    expect(journal(dataDirectory).begin("recover-corrupt", identity())).toBe(true);
    const record = readdirSync(dataDirectory).find((name) =>
      name.startsWith(".provider-maintenance-") && name.endsWith(".json"));
    writeFileSync(join(dataDirectory, record!), "{}", "utf8");

    await expect(recoverProviderMaintenanceJournal({
      journal: journal(dataDirectory, SECOND_GENERATION),
      installationLeases: new ProviderInstallationLeaseCoordinator(),
      runtime: runtime(vi.fn(async () => identity())),
      cwd: "/workspace",
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    })).rejects.toThrow("record is invalid");
  });
});
