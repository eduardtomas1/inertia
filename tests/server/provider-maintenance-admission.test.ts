import { describe, expect, it, vi } from "vitest";

import type { ProviderMaintenanceOperation } from "../../src/shared/provider-maintenance";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceTarget,
} from "../../src/server/provider/maintenance-capabilities";
import { ProviderMaintenanceController } from "../../src/server/provider/maintenance-controller";
import { ProviderLatestVersionCache } from "../../src/server/provider/maintenance-latest";
import type { ProviderMaintenanceJournalAuthority } from "../../src/server/provider/maintenance-journal";
import type { ProviderMaintenanceRunResult } from "../../src/server/provider/maintenance-runner";
import {
  ProviderInstallationLeaseCoordinator,
  providerInstallationIdentity,
  type ProviderInstallationIdentity,
} from "../../src/server/provider/installation-lease";
import { providerMaintenanceJournalTestDouble } from "../support/provider-maintenance-journal";

const PACKAGE = "@anthropic-ai/claude-code";

function target(version: string): ProviderMaintenanceTarget {
  return { providerId: "claude", executable: "/tools/claude", installedVersion: version, installed: true };
}

function identity(version: string): ProviderInstallationIdentity {
  return providerInstallationIdentity({
    providerId: "claude",
    executable: "/tools/claude",
    installationRootIdentity: null,
    packageIdentity: PACKAGE,
    version,
    environmentIdentity: "runtime-provider-environment",
  });
}

const capabilities: ProviderMaintenanceCapabilities = {
  providerId: "claude",
  packageName: PACKAGE,
  installMethod: "provider-managed",
  updateAvailability: "available",
  update: {
    executable: "/tools/claude",
    args: ["update"],
    lockKey: "claude",
    installMethod: "provider-managed",
    label: "Update claude",
  },
  instructionsUrl: "https://example.test/update",
};

function success(): ProviderMaintenanceRunResult {
  return {
    status: "succeeded",
    exitCode: 0,
    signal: null,
    message: "Provider update command completed.",
    cleanupConfirmed: true,
    output: "updated",
    outputTruncated: false,
  };
}

function terminal(events: ProviderMaintenanceOperation[]): Promise<ProviderMaintenanceOperation> {
  return vi.waitFor(() => {
    const event = events.findLast(({ status }) =>
      ["succeeded", "unchanged", "failed", "cancelled"].includes(status));
    if (!event) throw new Error("The update has not finished.");
    return event;
  });
}

function admits(leases: ProviderInstallationLeaseCoordinator, subject: ProviderInstallationIdentity): boolean {
  const admitted = (["compatibility-probe", "provider-run"] as const).map((kind) => {
    try {
      const use = leases.acquireUse(subject, { kind, operationId: `${kind}-after-update` });
      return use.release({ cleanupConfirmed: true });
    } catch {
      return false;
    }
  });
  expect(new Set(admitted).size).toBe(1);
  return admitted[0]!;
}

function updateController(
  journal: ProviderMaintenanceJournalAuthority,
  leases: ProviderInstallationLeaseCoordinator,
  runAction: () => Promise<ProviderMaintenanceRunResult> = async () => success(),
) {
  let current = target("1.0.0");
  const operations: ProviderMaintenanceOperation[] = [];
  const controller = new ProviderMaintenanceController({
    maintenanceJournal: journal,
    installationLeases: leases,
    target: () => current,
    refreshTarget: async () => {
      current = target("2.0.0");
      return current;
    },
    latestVersions: new ProviderLatestVersionCache({
      fetch: (async () => new Response(JSON.stringify({ version: "2.0.0" }))) as typeof fetch,
    }),
    resolveCapabilities: async () => capabilities,
    runAction,
    operationId: () => "00000000-0000-4000-8000-000000000001",
    onOperation: (operation) => operations.push(operation),
  });
  return { controller, operations };
}

describe("provider maintenance keeps shared installation admission closed while its journal is unresolved", () => {
  it("reopens admission after a verified update whose journal is retired", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const { controller, operations } = updateController(providerMaintenanceJournalTestDouble(), leases);

    await controller.startUpdate("claude");

    await expect(terminal(operations)).resolves.toMatchObject({ status: "succeeded" });
    expect(admits(leases, identity("2.0.0"))).toBe(true);
    expect(controller.hasBlockingAuthority("claude")).toBe(false);
  });

  it.each([
    ["throws", (): boolean => { throw new Error("A provider maintenance journal record is invalid."); }],
    ["is not durable", (): boolean => false],
  ] as const)("keeps admission closed when journal retirement %s after the lease completed", async (_label, retire) => {
    const journal = providerMaintenanceJournalTestDouble();
    const leases = new ProviderInstallationLeaseCoordinator();
    const { controller, operations } = updateController({ ...journal, retireVerified: retire }, leases);

    await controller.startUpdate("claude");

    await expect(terminal(operations)).resolves.toMatchObject({ status: "failed" });
    expect(admits(leases, identity("2.0.0"))).toBe(false);
    expect(admits(leases, identity("1.0.0"))).toBe(false);
    expect(leases.isQuarantined(identity("1.0.0"))).toBe(true);
    expect(controller.hasBlockingAuthority("claude")).toBe(true);
    expect(journal.pending()).toHaveLength(1);
  });

  it("keeps admission closed when lease completion throws after durable verification", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const acquire = leases.acquireMaintenance.bind(leases);
    vi.spyOn(leases, "acquireMaintenance").mockImplementation(async (...args) => {
      const lease = await acquire(...args);
      return {
        ...lease,
        identity: lease.identity,
        operationId: lease.operationId,
        authorizePostMaintenanceVerification: (receipt) => lease.authorizePostMaintenanceVerification(receipt),
        quarantine: (reason, observed) => lease.quarantine(reason, observed),
        complete: () => { throw new Error("Maintenance scope attachment failed."); },
      };
    });
    const journal = providerMaintenanceJournalTestDouble();
    const { controller, operations } = updateController(journal, leases);

    await controller.startUpdate("claude");

    await expect(terminal(operations)).resolves.toMatchObject({ status: "failed" });
    expect(admits(leases, identity("1.0.0"))).toBe(false);
    expect(admits(leases, identity("2.0.0"))).toBe(false);
    expect(journal.pending()).toHaveLength(1);
  });

  it("keeps admission closed when durable verification throws before completion", async () => {
    const journal = providerMaintenanceJournalTestDouble();
    const leases = new ProviderInstallationLeaseCoordinator();
    const { controller, operations } = updateController({
      ...journal,
      markVerified: () => { throw new Error("A provider maintenance journal record is invalid."); },
    }, leases);

    await controller.startUpdate("claude");

    await expect(terminal(operations)).resolves.toMatchObject({ status: "failed" });
    expect(admits(leases, identity("1.0.0"))).toBe(false);
    expect(journal.pending()).toHaveLength(1);
  });

  it.each([
    ["cannot be retired", (): boolean => false],
    ["throws while it is retired", (): boolean => { throw new Error("A provider maintenance journal record is invalid."); }],
  ] as const)("keeps admission closed when an unadmitted journal record %s", async (_label, abandon) => {
    const journal = providerMaintenanceJournalTestDouble();
    const leases = new ProviderInstallationLeaseCoordinator();
    const blocking = leases.acquireUse(identity("1.0.0"), {
      kind: "provider-run",
      operationId: "run-before-update",
    });
    const { controller, operations } = updateController({ ...journal, abandonUnadmitted: abandon }, leases);

    const started = await controller.startUpdate("claude");
    controller.cancel(started.id);
    await expect(terminal(operations)).resolves.toMatchObject({ status: "cancelled" });
    expect(blocking.release({ cleanupConfirmed: true })).toBe(true);

    expect(admits(leases, identity("1.0.0"))).toBe(false);
    expect(journal.pending()).toHaveLength(1);
  });

  it("reopens admission after a cancelled unadmitted update whose journal record is retired", async () => {
    const journal = providerMaintenanceJournalTestDouble();
    const leases = new ProviderInstallationLeaseCoordinator();
    const blocking = leases.acquireUse(identity("1.0.0"), {
      kind: "provider-run",
      operationId: "run-before-update",
    });
    const { controller, operations } = updateController(journal, leases);

    const started = await controller.startUpdate("claude");
    controller.cancel(started.id);
    await expect(terminal(operations)).resolves.toMatchObject({ status: "cancelled" });
    expect(blocking.release({ cleanupConfirmed: true })).toBe(true);

    expect(admits(leases, identity("1.0.0"))).toBe(true);
    expect(journal.pending()).toHaveLength(0);
  });
});
