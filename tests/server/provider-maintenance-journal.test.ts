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
import {
  ProviderMaintenanceJournal,
  validateProviderMaintenanceJournalStorage,
} from
  "../../src/server/provider/maintenance-journal";
import {
  recoverProviderMaintenanceJournal,
  type ProviderMaintenanceRecoveryRuntime,
} from
  "../../src/server/provider/maintenance-recovery";
import { PROVIDER_MAINTENANCE_PROVIDER_IDS } from
  "../../src/shared/provider-maintenance";

const roots: string[] = [];
const FIRST_GENERATION = "00000000-0000-4000-8000-000000000001:1";
const SECOND_GENERATION = "00000000-0000-4000-8000-000000000002:1";
const BOOT_ID = "test:00000000-0000-4000-8000-000000000001";
const NEXT_BOOT_ID = "test:00000000-0000-4000-8000-000000000002";

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
      runtimeCleanupConfirmed: false,
    }]);
    expect(reopened.markVerified("maintenance-1", observed)).toBe(true);
    expect(journal(dataDirectory).pending()[0]?.verifiedIdentity).toEqual(observed);
    expect(reopened.retireVerified("maintenance-1", observed)).toBe(true);
    expect(journal(dataDirectory).pending()).toEqual([]);
  });

  it.each(PROVIDER_MAINTENANCE_PROVIDER_IDS)(
    "reads back the %s record from durable storage",
    (providerId) => {
      const dataDirectory = root();
      const coordinates = {
        providerId,
        executable: `/tools/${providerId}`,
        installationRootIdentity: null,
        packageIdentity: null,
        environmentIdentity: "test-environment",
      };
      const owning = providerInstallationIdentity({
        ...coordinates,
        version: "1.0.0",
      });
      const observed = providerInstallationIdentity({
        ...coordinates,
        version: "2.0.0",
      });
      expect(journal(dataDirectory).begin(`${providerId}-update`, owning))
        .toBe(true);

      expect(() => validateProviderMaintenanceJournalStorage(dataDirectory))
        .not.toThrow();
      const reopened = journal(dataDirectory, SECOND_GENERATION);
      expect(reopened.pending()).toEqual([expect.objectContaining({
        operationId: `${providerId}-update`,
        installationIdentity: owning,
      })]);
      expect(reopened.markVerified(`${providerId}-update`, observed)).toBe(true);
      expect(reopened.retireVerified(`${providerId}-update`, observed)).toBe(true);
      expect(journal(dataDirectory).pending()).toEqual([]);
    },
  );

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

  it("checkpoints only exact generation or confirmed prior-boot cleanup", () => {
    const subject = journal(root());
    expect(subject.begin("cleanup-checkpoint", identity())).toBe(true);
    const reconcile = (generation: string, boot = BOOT_ID, priorBootCleanupConfirmed = false) => subject.reconcile({
      confirmedRuntimeGenerationIds: new Set([generation]),
      currentSystemBootId: boot,
      priorBootCleanupConfirmed,
    })[0]!;
    expect(reconcile(SECOND_GENERATION).runtimeCleanupConfirmed).toBe(false);
    expect(reconcile(SECOND_GENERATION, NEXT_BOOT_ID).runtimeCleanupConfirmed).toBe(false);
    expect(reconcile(SECOND_GENERATION, NEXT_BOOT_ID, true).runtimeCleanupConfirmed).toBe(true);
    expect(subject.abandonUnadmitted("cleanup-checkpoint", identity())).toBe(false);
  });

  it.each([
    ["unavailable", BOOT_ID],
    [BOOT_ID, "unavailable"],
    ["unavailable", "unavailable"],
    [BOOT_ID, "invalid-boot-id"],
  ])("requires exact generation cleanup when boot identity is unknown (%s -> %s)", (recordBootId, currentBootId) => {
    const dataDirectory = root();
    const subject = new ProviderMaintenanceJournal(dataDirectory, {
      runtimeGenerationId: FIRST_GENERATION, systemBootId: recordBootId,
    });
    expect(subject.begin("unknown-boot", identity())).toBe(true);
    const reconciliation = {
      confirmedRuntimeGenerationIds: new Set<string>(),
      currentSystemBootId: currentBootId, priorBootCleanupConfirmed: true,
    };
    expect(subject.reconcile(reconciliation)[0]?.runtimeCleanupConfirmed).toBe(false);
    expect(subject.reconcile({
      ...reconciliation, confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
    })[0]?.runtimeCleanupConfirmed).toBe(true);
  });

  it.each(["owning", "cleaned"])("retains cleanup proof when retirement of %s is interrupted", (phase) => {
    const dataDirectory = root();
    const subject = journal(dataDirectory);
    expect(subject.begin("interrupted-retirement", identity())).toBe(true);
    subject.reconcile({
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    });
    expect(subject.markVerified("interrupted-retirement", identity())).toBe(true);
    const interrupted = journal(dataDirectory, SECOND_GENERATION, {
      beforeUnlink: (path) => {
        if (path.endsWith(`.${phase}.json`)) throw new Error("injected unlink failure");
      },
    });
    expect(interrupted.retireVerified("interrupted-retirement", identity())).toBe(false);
    const reopened = journal(dataDirectory, SECOND_GENERATION);
    expect(reopened.pending()).toEqual([expect.objectContaining({ runtimeCleanupConfirmed: true })]);
    expect(() => validateProviderMaintenanceJournalStorage(dataDirectory)).not.toThrow();
    expect(reopened.markVerified("interrupted-retirement", identity())).toBe(true);
    expect(reopened.retireVerified("interrupted-retirement", identity())).toBe(true);
    expect(reopened.pending()).toEqual([]);
  });

  it("keeps ownership unconfirmed when cleanup checkpoint publication is interrupted", () => {
    const dataDirectory = root();
    expect(journal(dataDirectory).begin("interrupted-checkpoint", identity())).toBe(true);
    const interrupted = journal(dataDirectory, SECOND_GENERATION, {
      afterTemporaryFileClosed: (path) => {
        if (path.endsWith(".cleaned.publish.tmp")) throw new Error("injected publication failure");
      },
    });
    expect(() => interrupted.reconcile({
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID, priorBootCleanupConfirmed: false,
    })).toThrow("cleanup proof could not be persisted");
    expect(journal(dataDirectory).pending()).toEqual([
      expect.objectContaining({ runtimeCleanupConfirmed: false }),
    ]);
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

  it("retries failed conformance after restart without the consumed cleanup receipt", async () => {
    const dataDirectory = root();
    expect(journal(dataDirectory).begin("retry-after-restart", identity())).toBe(true);
    const options = {
      journal: journal(dataDirectory, SECOND_GENERATION),
      installationLeases: new ProviderInstallationLeaseCoordinator(),
      runtime: runtime(vi.fn(async () => { throw new Error("temporary verification failure"); })),
      cwd: "/workspace",
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    };
    await expect(recoverProviderMaintenanceJournal(options)).resolves.toHaveLength(1);
    const verify = vi.fn(async () => identity());
    await expect(recoverProviderMaintenanceJournal({
      ...options,
      journal: journal(dataDirectory, "00000000-0000-4000-8000-000000000003:1"),
      installationLeases: new ProviderInstallationLeaseCoordinator(),
      runtime: runtime(verify),
      confirmedRuntimeGenerationIds: new Set(),
    })).resolves.toEqual([]);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("does not verify a checkpointed installation when provider execution is disabled", async () => {
    const dataDirectory = root();
    expect(journal(dataDirectory).begin("disabled-recovery", identity())).toBe(true);
    const verify = vi.fn(async () => identity());
    await expect(recoverProviderMaintenanceJournal({
      journal: journal(dataDirectory, SECOND_GENERATION),
      installationLeases: new ProviderInstallationLeaseCoordinator(),
      runtime: runtime(verify), cwd: "/workspace",
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID, priorBootCleanupConfirmed: false,
      verificationEnabled: false,
    })).resolves.toHaveLength(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it("retires a verified record left unretired and reopens admission only after startup recovery", async () => {
    const dataDirectory = root();
    const owning = identity();
    const verified = identity("2.0.0");
    expect(journal(dataDirectory).begin("recover-unretired", owning)).toBe(true);
    expect(journal(dataDirectory).markVerified("recover-unretired", verified)).toBe(true);
    const leases = new ProviderInstallationLeaseCoordinator();

    await expect(recoverProviderMaintenanceJournal({
      journal: journal(dataDirectory, SECOND_GENERATION),
      installationLeases: leases,
      runtime: runtime(vi.fn(async () => verified)),
      cwd: "/workspace",
      confirmedRuntimeGenerationIds: new Set([FIRST_GENERATION]),
      currentSystemBootId: BOOT_ID,
      priorBootCleanupConfirmed: false,
    })).resolves.toEqual([]);
    expect(leases.isQuarantined(verified)).toBe(false);
    const reopened = leases.acquireUse(verified, {
      kind: "provider-run",
      operationId: "run-after-unretired-recovery",
    });
    expect(reopened.release({ cleanupConfirmed: true })).toBe(true);
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
