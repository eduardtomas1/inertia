// @inertia-test-suite portable
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "../../src/shared/provider-maintenance";
import type { ProviderModel } from "../../src/shared/contracts";
import { nativeBackendProfile } from "../../src/shared/model-routing";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceTarget,
} from "../../src/server/provider/maintenance-capabilities";
import {
  ProviderMaintenanceController,
} from "../../src/server/provider/maintenance-controller";
import type {
  ProviderMaintenanceRunResult,
} from "../../src/server/provider/maintenance-runner";
import {
  AgentHarnessRegistry,
  ProviderManager,
} from "../../src/server/providers";
import { createLegacyCliAgentHarnessForTests } from
  "../../src/server/provider/cli-agent-harness";
import {
  providerRunTerminal,
  type ProviderDetection,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  ProviderInstallationAdmissionError,
  ProviderInstallationLeaseCoordinator,
  providerInstallationIdentity,
  type ProviderInstallationBlocker,
  type ProviderInstallationCleanupReceipt,
  type ProviderInstallationIdentity,
  type ProviderInstallationMaintenanceLease,
  type ProviderInstallationVerificationAuthority,
} from "../../src/server/provider/installation-lease";
import { ProviderMetadataCache } from
  "../../src/server/provider/metadata";
import { nativeProviderRunInput } from "./model-route-fixture";
import { providerMaintenanceJournalTestDouble } from
  "../support/provider-maintenance-journal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function target(
  providerId: ProviderMaintenanceProviderId = "claude",
  version = "1.0.0",
  executable = `/tools/${providerId}`,
): ProviderMaintenanceTarget {
  return {
    providerId,
    executable,
    installedVersion: version,
    installed: true,
  };
}

function capabilities(
  providerId: ProviderMaintenanceProviderId = "claude",
  lockKey = `provider-managed:${providerId}`,
): ProviderMaintenanceCapabilities {
  return {
    providerId,
    packageName: null,
    installMethod: "provider-managed",
    updateAvailability: "available",
    update: {
      executable: `/tools/${providerId}`,
      args: ["update"],
      lockKey,
      installMethod: "provider-managed",
      label: `Update ${providerId}`,
    },
    instructionsUrl: "https://example.test/update",
  };
}

function providerModel(id: string): ProviderModel {
  return {
    id,
    label: id[0]!.toLocaleUpperCase("en-US") + id.slice(1),
    description: `${id} model`,
    isDefault: false,
    inputModalities: ["text"],
    reasoningOptions: [],
    defaultReasoningEffort: "",
  };
}

function identity(
  providerId: ProviderMaintenanceProviderId = "claude",
  version = "1.0.0",
  executable = `/tools/${providerId}`,
  lockKey = `provider-managed:${providerId}`,
  replacementBoundary = executable,
): ProviderInstallationIdentity {
  return providerInstallationIdentity({
    providerId,
    executable,
    installationRootIdentity: lockKey,
    packageIdentity: null,
    version,
    environmentIdentity: "runtime-provider-environment",
    replacementBoundaryIdentity: replacementBoundary,
  });
}

function success(
  cleanupConfirmed = true,
): ProviderMaintenanceRunResult {
  return {
    status: "succeeded",
    exitCode: 0,
    signal: null,
    message: "Provider update command completed.",
    cleanupConfirmed,
    output: "updated",
    outputTruncated: false,
  };
}

function terminalOperation() {
  const terminal = deferred<ProviderMaintenanceOperation>();
  let settled = false;
  return {
    promise: terminal.promise,
    observe: (operation: ProviderMaintenanceOperation): void => {
      if (
        !settled
        && ["succeeded", "unchanged", "failed", "cancelled"].includes(
          operation.status,
        )
      ) {
        settled = true;
        terminal.resolve(operation);
      }
    },
  };
}

function verificationAuthority(
  lease: ProviderInstallationMaintenanceLease,
): ProviderInstallationVerificationAuthority {
  const authority = lease.authorizePostMaintenanceVerification({
    cleanupConfirmed: true,
  });
  expect(authority).not.toBeNull();
  return authority!;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider installation lease coordinator", () => {
  it("closes admission synchronously, reports exact readers, and waits for cleanup receipts", async () => {
    const coordinator = new ProviderInstallationLeaseCoordinator();
    const installation = identity();
    const run = coordinator.acquireUse(installation, {
      kind: "provider-run",
      operationId: "run-1",
    });
    const metadata = coordinator.acquireUse(installation, {
      kind: "metadata-discovery",
      operationId: "metadata-1",
    });
    const reported: ProviderInstallationBlocker[][] = [];
    let acquired = false;
    const maintenance = coordinator.acquireMaintenance(installation, {
      operationId: "maintenance-1",
      onBlockers: (blockers) => {
        reported.push([...blockers]);
      },
    }).then((lease) => {
      acquired = true;
      return lease;
    });

    expect(reported).toEqual([[
      expect.objectContaining({
        kind: "provider-run",
        operationId: "run-1",
        fingerprintMatches: true,
      }),
      expect.objectContaining({
        kind: "metadata-discovery",
        operationId: "metadata-1",
        fingerprintMatches: true,
      }),
    ]]);
    expect(() => coordinator.acquireUse(installation, {
      kind: "compatibility-probe",
      operationId: "probe-late",
    })).toThrowError(ProviderInstallationAdmissionError);
    expect(coordinator.blockers(installation)).toContainEqual(
      expect.objectContaining({
        kind: "maintenance-pending",
        operationId: "maintenance-1",
      }),
    );

    expect(run.release({ cleanupConfirmed: true })).toBe(true);
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(metadata.release({ cleanupConfirmed: true })).toBe(true);
    const lease = await maintenance;
    expect(acquired).toBe(true);
    verificationAuthority(lease);
    expect(lease.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: installation,
    })).toBe(true);
    expect(coordinator.blockers(installation)).toEqual([]);
  });

  it("keeps separate physical installations concurrent even for one provider", async () => {
    const coordinator = new ProviderInstallationLeaseCoordinator();
    const claude = identity("claude");
    const otherClaude = identity(
      "claude",
      "1.0.0",
      "/tools/alternate/claude",
    );
    const reader = coordinator.acquireUse(claude, {
      kind: "provider-run",
      operationId: "claude-run",
    });
    const maintenance = coordinator.acquireMaintenance(claude, {
      operationId: "claude-maintenance",
    });

    const other = coordinator.acquireUse(otherClaude, {
      kind: "provider-run",
      operationId: "alternate-claude-run",
    });
    expect(other.release({ cleanupConfirmed: true })).toBe(true);
    expect(reader.release({ cleanupConfirmed: true })).toBe(true);
    const lease = await maintenance;
    verificationAuthority(lease);
    expect(lease.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: claude,
    })).toBe(true);
  });

  it("reopens admission when a pending maintenance request is cancelled", async () => {
    const coordinator = new ProviderInstallationLeaseCoordinator();
    const installation = identity();
    const reader = coordinator.acquireUse(installation, {
      kind: "provider-run",
      operationId: "run-before-cancel",
    });
    const abort = new AbortController();
    const maintenance = coordinator.acquireMaintenance(installation, {
      operationId: "cancelled-maintenance",
      signal: abort.signal,
    });
    abort.abort();

    await expect(maintenance).rejects.toThrow(
      "maintenance admission was cancelled",
    );
    const admitted = coordinator.acquireUse(installation, {
      kind: "metadata-discovery",
      operationId: "metadata-after-cancel",
    });
    expect(admitted.release({ cleanupConfirmed: true })).toBe(true);
    expect(reader.release({ cleanupConfirmed: true })).toBe(true);
  });

  it("bounds reader drain and preserves exact blocker evidence on timeout", async () => {
    vi.useFakeTimers();
    const coordinator = new ProviderInstallationLeaseCoordinator();
    const installation = identity();
    const reader = coordinator.acquireUse(installation, {
      kind: "isolation-proof",
      operationId: "isolation-proof-1",
    });
    const maintenance = coordinator.acquireMaintenance(installation, {
      operationId: "maintenance-timeout",
      waitTimeoutMs: 50,
    }).then((value) => value, (error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);
    const error = await maintenance;
    expect(error).toBeInstanceOf(ProviderInstallationAdmissionError);
    expect((error as ProviderInstallationAdmissionError).blockers).toEqual([
      expect.objectContaining({
        kind: "isolation-proof",
        operationId: "isolation-proof-1",
        scopeId: installation.scopeId,
      }),
    ]);
    const admitted = coordinator.acquireUse(installation, {
      kind: "metadata-discovery",
      operationId: "metadata-after-timeout",
    });
    admitted.release({ cleanupConfirmed: true });
    reader.release({ cleanupConfirmed: true });
  });

  it("retains quarantine after unconfirmed use cleanup or a mismatched maintenance receipt", async () => {
    const useCoordinator = new ProviderInstallationLeaseCoordinator();
    const installation = identity();
    const use = useCoordinator.acquireUse(installation, {
      kind: "provider-server",
      operationId: "server-1",
    });
    expect(use.quarantine("owned-server-cleanup-unconfirmed")).toBe(true);
    expect(useCoordinator.isQuarantined(installation)).toBe(true);
    expect(() => useCoordinator.acquireUse(installation, {
      kind: "provider-run",
      operationId: "replacement-run",
    })).toThrowError(ProviderInstallationAdmissionError);

    const maintenanceCoordinator = new ProviderInstallationLeaseCoordinator();
    const maintenance = await maintenanceCoordinator.acquireMaintenance(
      installation,
      { operationId: "maintenance-bad-receipt" },
    );
    verificationAuthority(maintenance);
    const unexpected = identity("claude", "2.0.0", "/other/claude");
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: unexpected,
    })).toBe(false);
    expect(maintenanceCoordinator.isQuarantined(installation)).toBe(true);
    expect(maintenanceCoordinator.isQuarantined(unexpected)).toBe(true);
  });

  it("scopes by canonical executable and keeps mutable installation evidence in the fingerprint", () => {
    const first = identity(
      "claude",
      "1.0.0",
      "/canonical/claude",
      "package-manager:first",
    );
    const changed = identity(
      "claude",
      "2.0.0",
      "/canonical/claude",
      "package-manager:second",
    );
    const alternate = identity(
      "claude",
      "2.0.0",
      "/canonical/other-claude",
      "package-manager:first",
    );

    expect(changed.scopeId).toBe(first.scopeId);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(alternate.scopeId).not.toBe(first.scopeId);

    const rootOnly = providerInstallationIdentity({
      providerId: "claude",
      executable: null,
      installationRootIdentity: "/canonical/provider-root",
      packageIdentity: "@anthropic-ai/claude-code",
      version: "1.0.0",
    });
    const changedRoot = providerInstallationIdentity({
      providerId: "claude",
      executable: null,
      installationRootIdentity: "/canonical/other-provider-root",
      packageIdentity: "@anthropic-ai/claude-code",
      version: "1.0.0",
    });
    expect(changedRoot.scopeId).not.toBe(rootOnly.scopeId);
  });

  it("closes a stable replacement boundary across an executable realpath swap", async () => {
    const coordinator = new ProviderInstallationLeaseCoordinator();
    const boundary = "provider-route:/configured/claude";
    const before = identity(
      "claude",
      "1.0.0",
      "/resolved/claude-v1",
      "provider-managed:claude",
      boundary,
    );
    const after = identity(
      "claude",
      "2.0.0",
      "/resolved/claude-v2",
      "provider-managed:claude",
      boundary,
    );
    const unrelated = identity(
      "claude",
      "2.0.0",
      "/other/claude",
      "provider-managed:claude",
      "provider-route:/other/claude",
    );
    const maintenance = await coordinator.acquireMaintenance(before, {
      operationId: "maintenance-symlink-swap",
    });

    expect(after.scopeId).not.toBe(before.scopeId);
    expect(after.boundaryId).toBe(before.boundaryId);
    expect(() => coordinator.acquireUse(after, {
      kind: "provider-run",
      operationId: "run-after-swap",
    })).toThrowError(ProviderInstallationAdmissionError);
    const unrelatedUse = coordinator.acquireUse(unrelated, {
      kind: "provider-run",
      operationId: "unrelated-installation",
    });
    expect(unrelatedUse.release({ cleanupConfirmed: true })).toBe(true);

    const authority = verificationAuthority(maintenance);
    const verification = coordinator.acquireUse(after, {
      kind: "compatibility-probe",
      operationId: authority.operationId,
    }, { verificationAuthority: authority });
    expect(verification.release({ cleanupConfirmed: true })).toBe(true);
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: after,
    })).toBe(true);
  });

  it("admits only exact post-command verification operations through maintenance authority", async () => {
    const coordinator = new ProviderInstallationLeaseCoordinator();
    const installation = identity();
    const updated = identity("claude", "2.0.0");
    const maintenance = await coordinator.acquireMaintenance(installation, {
      operationId: "maintenance-verification",
    });
    const authority = verificationAuthority(maintenance);

    expect(() => coordinator.acquireUse(updated, {
      kind: "provider-run",
      operationId: authority.operationId,
    }, { verificationAuthority: authority })).toThrowError(
      ProviderInstallationAdmissionError,
    );
    expect(() => coordinator.acquireUse(updated, {
      kind: "metadata-discovery",
      operationId: "different-operation",
    }, { verificationAuthority: authority })).toThrowError(
      ProviderInstallationAdmissionError,
    );

    const metadata = coordinator.acquireUse(updated, {
      kind: "metadata-discovery",
      operationId: authority.operationId,
    }, { verificationAuthority: authority });
    expect(coordinator.blockers(updated)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "maintenance-active",
        operationId: "maintenance-verification",
        fingerprintMatches: false,
      }),
      expect.objectContaining({
        kind: "metadata-discovery",
        operationId: "maintenance-verification",
        fingerprintMatches: true,
      }),
    ]));
    expect(metadata.release({ cleanupConfirmed: true })).toBe(true);
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: updated,
    })).toBe(true);
    expect(() => coordinator.acquireUse(updated, {
      kind: "drift-verification",
      operationId: authority.operationId,
    }, { verificationAuthority: authority })).toThrowError(
      "authority is invalid or expired",
    );
  });

  it("quarantines when cleanup is unconfirmed during verification", async () => {
    const coordinator = new ProviderInstallationLeaseCoordinator();
    const installation = identity();
    const maintenance = await coordinator.acquireMaintenance(installation, {
      operationId: "maintenance-unconfirmed-verification",
    });
    const authority = verificationAuthority(maintenance);
    const verification = coordinator.acquireUse(installation, {
      kind: "compatibility-probe",
      operationId: authority.operationId,
    }, { verificationAuthority: authority });
    const invalidReceipt = {
      cleanupConfirmed: false,
    } as unknown as ProviderInstallationCleanupReceipt;

    expect(verification.release(invalidReceipt)).toBe(false);
    expect(coordinator.isQuarantined(installation)).toBe(true);
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: installation,
    })).toBe(false);
  });

  it("never clears maintenance while an authority-bound verification still owns work", async () => {
    const coordinator = new ProviderInstallationLeaseCoordinator();
    const installation = identity();
    const maintenance = await coordinator.acquireMaintenance(installation, {
      operationId: "maintenance-active-verification",
    });
    const authority = verificationAuthority(maintenance);
    const verification = coordinator.acquireUse(installation, {
      kind: "drift-verification",
      operationId: authority.operationId,
    }, { verificationAuthority: authority });

    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: installation,
    })).toBe(false);
    expect(coordinator.isQuarantined(installation)).toBe(true);
    expect(verification.release({ cleanupConfirmed: true })).toBe(false);
    expect(() => coordinator.acquireUse(installation, {
      kind: "provider-run",
      operationId: "run-after-active-verification",
    })).toThrowError(ProviderInstallationAdmissionError);
  });
});

describe("provider maintenance installation ownership", () => {
  it("blocks executable and backend-profile mutation while the provider is owned", () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const installation = identity("codex", "1.0.0", "/tools/codex");
    const run = leases.acquireUse(installation, {
      kind: "provider-run",
      operationId: "run-blocks-configuration",
    });
    const manager = ProviderManager.createForTests({
      commands: { codex: "/tools/codex" },
      installationLeases: leases,
    });

    expect(() => manager.setCommand("codex", "/tools/codex-v2"))
      .toThrow(ProviderInstallationAdmissionError);
    expect(() => manager.upsertBackendProfile(
      nativeBackendProfile("codex"),
      "codex",
    )).toThrow(ProviderInstallationAdmissionError);
    expect(run.release({ cleanupConfirmed: true })).toBe(true);
    expect(() => manager.setCommand("codex", "/tools/codex-v2"))
      .not.toThrow();
  });

  it("waits for exact owners, blocks new probes, revalidates, and then reopens admission", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    let current = target();
    const installation = identity();
    const activeRun = leases.acquireUse(installation, {
      kind: "provider-run",
      operationId: "active-provider-run",
    });
    const terminal = terminalOperation();
    const blockers: ProviderInstallationBlocker[][] = [];
    const verificationLifecycle: string[] = [];
    const runAction = vi.fn(async () => {
      current = target("claude", "2.0.0");
      return success();
    });
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: () => current,
      refreshTarget: async (_providerId, authority) => {
        verificationLifecycle.push("refresh");
        expect(authority).toMatchObject({
          providerId: "claude",
          operationId: "maintenance-waits-for-run",
          scopeId: installation.scopeId,
        });
        const metadata = leases.acquireUse(identity("claude", "2.0.0"), {
          kind: "metadata-discovery",
          operationId: authority!.operationId,
        }, { verificationAuthority: authority });
        expect(metadata.release({ cleanupConfirmed: true })).toBe(true);
        return current;
      },
      resolveCapabilities: async () => capabilities(),
      runAction,
      installationLeases: leases,
      operationId: () => "maintenance-waits-for-run",
      invalidateInstallationEvidence: (_providerId, authority, reason) => {
        verificationLifecycle.push("invalidate");
        expect(reason).toBe("post-maintenance-verification");
        expect(authority?.operationId).toBe("maintenance-waits-for-run");
      },
      onBlockers: (_providerId, currentBlockers) => {
        blockers.push([...currentBlockers]);
      },
      onOperation: terminal.observe,
    });

    await controller.startUpdate("claude");
    expect(runAction).not.toHaveBeenCalled();
    expect(blockers).toEqual([[
      expect.objectContaining({
        kind: "provider-run",
        operationId: "active-provider-run",
        scopeId: installation.scopeId,
      }),
    ]]);
    expect(() => leases.acquireUse(installation, {
      kind: "compatibility-probe",
      operationId: "late-probe",
    })).toThrowError(ProviderInstallationAdmissionError);

    activeRun.release({ cleanupConfirmed: true });
    await expect(terminal.promise).resolves.toMatchObject({
      status: "succeeded",
      beforeVersion: "1.0.0",
      afterVersion: "2.0.0",
    });
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(verificationLifecycle).toEqual(["invalidate", "refresh"]);
    const replacement = leases.acquireUse(identity("claude", "2.0.0"), {
      kind: "provider-run",
      operationId: "replacement-run",
    });
    expect(replacement.release({ cleanupConfirmed: true })).toBe(true);
  });

  it("quarantines a target that changes before the maintenance command starts", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    let current = target();
    const activeRun = leases.acquireUse(identity(), {
      kind: "provider-run",
      operationId: "draining-run",
    });
    const terminal = terminalOperation();
    const runAction = vi.fn(async () => success());
    const invalidations: Array<{
      authority: ProviderInstallationVerificationAuthority | null;
      reason: string;
    }> = [];
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: () => current,
      refreshTarget: async () => current,
      resolveCapabilities: async () => capabilities(),
      runAction,
      installationLeases: leases,
      operationId: () => "maintenance-preflight-drift",
      invalidateInstallationEvidence: (_providerId, authority, reason) => {
        invalidations.push({ authority, reason });
      },
      onOperation: terminal.observe,
    });

    await controller.startUpdate("claude");
    current = target("claude", "1.1.0");
    activeRun.release({ cleanupConfirmed: true });

    await expect(terminal.promise).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("changed before"),
    });
    expect(runAction).not.toHaveBeenCalled();
    expect(leases.isQuarantined(identity("claude", "1.1.0"))).toBe(true);
    expect(invalidations).toEqual([{
      authority: null,
      reason: "installation-uncertain",
    }]);
  });

  it("never advertises success or reopens admission after unconfirmed updater cleanup", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const terminal = terminalOperation();
    const refreshTarget = vi.fn(async () => target("claude", "2.0.0"));
    const invalidations: Array<{
      authority: ProviderInstallationVerificationAuthority | null;
      reason: string;
    }> = [];
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: () => target(),
      refreshTarget,
      resolveCapabilities: async () => capabilities(),
      runAction: async () => success(false),
      installationLeases: leases,
      operationId: () => "maintenance-unconfirmed-cleanup",
      invalidateInstallationEvidence: (_providerId, authority, reason) => {
        invalidations.push({ authority, reason });
      },
      onOperation: terminal.observe,
    });

    await controller.startUpdate("claude");
    await expect(terminal.promise).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("cleanup could not be confirmed"),
    });
    expect(leases.isQuarantined(identity())).toBe(true);
    expect(refreshTarget).not.toHaveBeenCalled();
    expect(invalidations).toEqual([{
      authority: null,
      reason: "installation-uncertain",
    }]);
    expect(controller.hasBlockingAuthority()).toBe(true);
    expect(() => leases.acquireUse(identity(), {
      kind: "provider-run",
      operationId: "unsafe-replacement",
    })).toThrowError(ProviderInstallationAdmissionError);
    await expect(controller.dispose()).rejects.toThrow(
      "cleanup could not be confirmed",
    );
  });
});

describe("provider manager installation ownership", () => {
  it("holds exact run and owned-server installation authority through terminal cleanup", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const input = nativeProviderRunInput({
      providerId: "codex",
      harnessId: "codex-cli",
      conversationId: "lease-run-conversation",
      runId: "lease-run-id",
      turnId: "lease-turn-id",
      cwd: "/workspace",
      prompt: "Hold installation ownership",
      interactionMode: "build",
      access: "supervised",
    });
    const terminal = deferred<ProviderRunResult>();
    const baseHarness = createLegacyCliAgentHarnessForTests("codex");
    const manager = ProviderManager.createForTests(
      {
        commands: { codex: "/tools/codex" },
        installationLeases: leases,
        installationOperationId: () => "manager-operation",
      },
      new AgentHarnessRegistry([{
        ...baseHarness,
        start: () => ({
          harnessId: "codex-cli",
          providerId: "codex",
          result: terminal.promise,
          cancel: () => undefined,
          extension: { kind: "cli", providerId: "codex" },
        }),
      }]),
    );
    const blockers: ProviderInstallationBlocker[][] = [];

    const result = manager.run(input);
    const maintenancePending = leases.acquireMaintenance(identity("codex"), {
      operationId: "maintenance-after-run",
      onBlockers: (current) => blockers.push([...current]),
    });
    expect(blockers).toEqual([[
      expect.objectContaining({
        kind: "provider-run",
        operationId: input.runId,
        scopeId: identity("codex").scopeId,
      }),
    ]]);
    await expect(manager.detect("codex")).rejects.toThrow(
      ProviderInstallationAdmissionError,
    );

    terminal.resolve({
      ...providerRunTerminal(input, "completed"),
      text: "done",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await expect(result).resolves.toMatchObject({
      runId: input.runId,
      turnId: input.turnId,
      cleanupConfirmed: true,
    });
    const maintenance = await maintenancePending;
    verificationAuthority(maintenance);
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: identity("codex", "2.0.0"),
    })).toBe(true);
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("quarantines the exact run installation when terminal cleanup is unconfirmed", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const input = nativeProviderRunInput({
      providerId: "codex",
      harnessId: "codex-cli",
      conversationId: "unconfirmed-lease-run",
      runId: "unconfirmed-lease-run-id",
      turnId: "unconfirmed-lease-turn-id",
      cwd: "/workspace",
      prompt: "Exercise cleanup quarantine",
      interactionMode: "build",
      access: "supervised",
    });
    const baseHarness = createLegacyCliAgentHarnessForTests("codex");
    const manager = ProviderManager.createForTests(
      {
        commands: { codex: "/tools/codex" },
        installationLeases: leases,
        cancelGraceMs: 100,
      },
      new AgentHarnessRegistry([{
        ...baseHarness,
        start: () => ({
          harnessId: "codex-cli",
          providerId: "codex",
          result: Promise.resolve({
            ...providerRunTerminal(input, "failed"),
            text: "",
            textTruncated: false,
            exitCode: null,
            signal: null,
            cleanupConfirmed: false,
          }),
          cancel: () => undefined,
          extension: { kind: "cli", providerId: "codex" },
        }),
      }]),
    );

    await expect(manager.run(input)).resolves.toMatchObject({
      cleanupConfirmed: false,
    });
    expect(leases.isQuarantined(identity("codex"))).toBe(true);
    await expect(leases.acquireMaintenance(identity("codex"), {
      operationId: "maintenance-after-unconfirmed-run",
    })).rejects.toThrow(ProviderInstallationAdmissionError);
    await expect(manager.disposeAll()).rejects.toThrow(
      "Provider process cleanup could not be confirmed",
    );
  });

  it("waits for metadata cleanup and rejects late discovery before maintenance", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const metadataStarted = deferred<void>();
    const metadataResult = deferred<{ models: ProviderModel[] }>();
    const metadataCache = new ProviderMetadataCache({
      read: async () => {
        metadataStarted.resolve();
        return await metadataResult.promise;
      },
    });
    const detection = (providerId: "claude"): ProviderDetection => ({
      provider: { id: providerId, name: "Claude", command: "claude" },
      available: true,
      version: "1.0.0",
      executable: "/tools/claude",
      installState: "installed",
      authState: "authenticated",
      canRun: true,
      cleanupConfirmed: true,
    });
    const detectProvider = vi.fn(async () => detection("claude"));
    let nextOperation = 0;
    const manager = ProviderManager.createForTests({
      commands: { claude: "/tools/claude" },
      detectProvider,
      metadataCache,
      installationLeases: leases,
      installationOperationId: () => `operation-${++nextOperation}`,
    });

    const metadata = manager.metadata("claude", "/workspace", { force: true });
    await metadataStarted.promise;
    const blockers: ProviderInstallationBlocker[][] = [];
    const maintenancePending = leases.acquireMaintenance(identity("claude"), {
      operationId: "maintenance-after-metadata",
      onBlockers: (current) => blockers.push([...current]),
    });
    expect(blockers).toEqual([[
      expect.objectContaining({
        kind: "metadata-discovery",
        operationId: "metadata-discovery:operation-2",
      }),
    ]]);
    await expect(manager.validateCommand(
      "claude",
      "/tools/claude",
    )).rejects.toThrow(ProviderInstallationAdmissionError);
    expect(detectProvider).toHaveBeenCalledTimes(1);

    metadataResult.resolve({ models: [providerModel("sonnet")] });
    await expect(metadata).resolves.toMatchObject({
      models: [{ id: "sonnet", label: "Sonnet" }],
    });
    const maintenance = await maintenancePending;
    verificationAuthority(maintenance);
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: identity("claude", "2.0.0"),
    })).toBe(true);
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("quarantines an ordinary discovery that retargets a known installation", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    let invocation = 0;
    const manager = ProviderManager.createForTests({
      commands: { claude: "/tools/claude-v1" },
      installationLeases: leases,
      detectProvider: async (): Promise<ProviderDetection> => {
        invocation += 1;
        return {
          provider: { id: "claude", name: "Claude", command: "claude" },
          available: true,
          version: invocation === 1 ? "1.0.0" : "2.0.0",
          executable: invocation === 1
            ? "/tools/claude-v1"
            : "/tools/claude-v2",
          installState: "installed",
          authState: "authenticated",
          canRun: true,
          cleanupConfirmed: true,
        };
      },
    });

    await expect(manager.detect("claude")).resolves.toMatchObject({
      executable: "/tools/claude-v1",
    });
    const prior = manager.providerInstallationIdentityForMaintenance(
      "claude",
      "/tools/claude-v1",
      "1.0.0",
    );
    const retargeted = manager.providerInstallationIdentityForMaintenance(
      "claude",
      "/tools/claude-v2",
      "2.0.0",
    );

    await expect(manager.detect("claude")).rejects.toMatchObject({
      code: "lifecycle_corruption",
    });
    expect(leases.isQuarantined(prior)).toBe(true);
    expect(leases.isQuarantined(retargeted)).toBe(true);
    await expect(manager.disposeAll()).rejects.toThrow(
      "Provider process cleanup could not be confirmed",
    );
  });

  it("negotiates maintenance only for the exact verified installation", async () => {
    const manager = ProviderManager.createForTests({
      commands: { claude: "/tools/claude" },
      installationLeases: new ProviderInstallationLeaseCoordinator(),
      detectProvider: async (): Promise<ProviderDetection> => ({
        provider: { id: "claude", name: "Claude", command: "claude" },
        available: true,
        version: "1.0.0",
        executable: "/tools/claude",
        installState: "installed",
        authState: "authenticated",
        canRun: true,
        cleanupConfirmed: true,
      }),
    });

    expect(manager.providerMaintenanceCapabilityAvailable(
      "claude",
      "/tools/claude",
      true,
    )).toBe(false);
    await manager.detect("claude");
    expect(manager.providerMaintenanceCapabilityAvailable(
      "claude",
      "/tools/claude",
      true,
    )).toBe(true);
    expect(manager.providerMaintenanceCapabilityAvailable(
      "claude",
      "/tools/replaced-claude",
      true,
    )).toBe(false);
    expect(manager.providerMaintenanceCapabilityAvailable(
      "claude",
      "/tools/claude",
      false,
    )).toBe(false);
    await manager.disposeAll();
  });

  it("invalidates capability evidence when the verified executable file changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-provider-identity-"));
    const executable = join(root, "claude");
    writeFileSync(executable, "provider-v1");
    const manager = ProviderManager.createForTests({
      commands: { claude: executable },
      installationLeases: new ProviderInstallationLeaseCoordinator(),
      detectProvider: async (): Promise<ProviderDetection> => ({
        provider: { id: "claude", name: "Claude", command: "claude" },
        available: true,
        version: "1.0.0",
        executable,
        installState: "installed",
        authState: "authenticated",
        canRun: true,
        cleanupConfirmed: true,
      }),
    });

    try {
      await manager.detect("claude");
      expect(manager.providerMaintenanceCapabilityAvailable(
        "claude",
        executable,
        true,
      )).toBe(true);
      writeFileSync(executable, "provider-v2-with-different-size");
      expect(manager.providerMaintenanceCapabilityAvailable(
        "claude",
        executable,
        true,
      )).toBe(false);
      await manager.disposeAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses one exact maintenance authority for nested detect and metadata verification", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const metadataCache = new ProviderMetadataCache({
      read: async () => ({ models: [providerModel("sonnet")] }),
    });
    const detectProvider = vi.fn(async (): Promise<ProviderDetection> => ({
      provider: { id: "claude", name: "Claude", command: "claude" },
      available: true,
      version: "2.0.0",
      executable: "/tools/claude",
      installState: "installed",
      authState: "authenticated",
      canRun: true,
      cleanupConfirmed: true,
    }));
    const manager = ProviderManager.createForTests({
      commands: { claude: "/tools/claude" },
      detectProvider,
      metadataCache,
      installationLeases: leases,
      installationOperationId: () => "ordinary-operation-must-not-be-used",
    });
    const maintenance = await leases.acquireMaintenance(identity("claude"), {
      operationId: "maintenance-verifies-provider-manager",
    });
    const authority = verificationAuthority(maintenance);

    await expect(manager.metadata("claude", "/workspace", {
      force: true,
      installationVerificationAuthority: authority,
    })).resolves.toMatchObject({
      models: [{ id: "sonnet", label: "Sonnet" }],
    });
    expect(detectProvider).toHaveBeenCalledTimes(1);
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: identity("claude", "2.0.0"),
    })).toBe(true);
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("transfers auth descriptor ownership to the downstream process cleanup owner", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const detectProvider = vi.fn(async (): Promise<ProviderDetection> => ({
      provider: { id: "claude", name: "Claude", command: "claude" },
      available: true,
      version: "1.0.0",
      executable: "/tools/claude",
      installState: "installed",
      authState: "authenticated",
      canRun: true,
      cleanupConfirmed: true,
    }));
    const manager = ProviderManager.createForTests({
      commands: { claude: "/tools/claude" },
      detectProvider,
      installationLeases: leases,
      installationOperationId: () => "auth-transfer-operation",
    });
    const launch = await manager.authLaunch("claude");
    const installation = manager.providerInstallationIdentityForMaintenance(
      "claude",
      "/tools/claude",
      "1.0.0",
    );
    let maintenanceAcquired = false;
    const pending = leases.acquireMaintenance(installation, {
      operationId: "maintenance-waits-for-auth",
    }).then((lease) => {
      maintenanceAcquired = true;
      return lease;
    });
    await Promise.resolve();
    expect(maintenanceAcquired).toBe(false);
    expect(leases.blockers(installation)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "auth-discovery",
        operationId: "auth-discovery:auth-transfer-operation",
      }),
    ]));

    const downstream = launch.installationUse.accept();
    expect(downstream).not.toBeNull();
    expect(downstream!.release({ cleanupConfirmed: true })).toBe(true);
    expect(downstream!.release({ cleanupConfirmed: true })).toBe(false);
    const maintenance = await pending;
    const authority = verificationAuthority(maintenance);
    const verification = leases.acquireUse(installation, {
      kind: "compatibility-probe",
      operationId: authority.operationId,
    }, { verificationAuthority: authority });
    expect(verification.release({ cleanupConfirmed: true })).toBe(true);
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: installation,
    })).toBe(true);
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("releases an unspawned descriptor only through explicit abandonment", async () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const manager = ProviderManager.createForTests({
      commands: { claude: "/tools/claude" },
      detectProvider: async (): Promise<ProviderDetection> => ({
        provider: { id: "claude", name: "Claude", command: "claude" },
        available: true,
        version: "1.0.0",
        executable: "/tools/claude",
        installState: "installed",
        authState: "authenticated",
        canRun: true,
        cleanupConfirmed: true,
      }),
      installationLeases: leases,
    });
    const launch = await manager.authLaunch("claude");
    expect(launch.installationUse.abandonBeforeSpawn()).toBe(true);
    expect(launch.installationUse.accept()).toBeNull();
    const installation = manager.providerInstallationIdentityForMaintenance(
      "claude",
      "/tools/claude",
      "1.0.0",
    );
    const maintenance = await leases.acquireMaintenance(installation, {
      operationId: "maintenance-after-abandoned-auth",
    });
    const authority = verificationAuthority(maintenance);
    const verification = leases.acquireUse(installation, {
      kind: "compatibility-probe",
      operationId: authority.operationId,
    }, { verificationAuthority: authority });
    expect(verification.release({ cleanupConfirmed: true })).toBe(true);
    expect(maintenance.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity: installation,
    })).toBe(true);
  });
});
