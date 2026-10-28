// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentHarnessRegistry,
  ProviderManager,
  type AgentHarness,
  type AgentHarnessStartOptions,
  type ProviderDetection,
  type ProviderId,
  type ProviderInstallationEvent,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/providers";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { CODEX_APP_SERVER_HARNESS_CAPABILITIES } from "../../src/server/provider/codex-app-server-harness";
import { PROVIDER_INFO } from "../../src/server/provider/catalog";
import { providerRunTerminal } from "../../src/server/provider/contracts";
import {
  ProviderInstallationAdmissionError,
  ProviderInstallationLeaseCoordinator,
} from "../../src/server/provider/installation-lease";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { ProcessTreeTerminationError } from "../../src/server/process-lifecycle";
import { nativeProviderRunInput } from "./model-route-fixture";

const managers: ProviderManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.disposeAll().catch(() => undefined);
  }
}, 30_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function detection(
  providerId: ProviderId,
  executable: string,
  version: string,
  cleanupConfirmed = true,
): ProviderDetection {
  return {
    provider: PROVIDER_INFO[providerId],
    available: true,
    executable,
    version,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    protocolVerified: true,
    cleanupConfirmed,
  };
}

function production(options: {
  detect: (providerId: ProviderId) => ProviderDetection;
  leases?: ProviderInstallationLeaseCoordinator;
  metadataCache?: ProviderMetadataCache;
  harness?: AgentHarness;
}) {
  const leases = options.leases ?? new ProviderInstallationLeaseCoordinator();
  const events: ProviderInstallationEvent[] = [];
  const manager = ProviderManager.createProduction({
    installationLeases: leases,
    conversationProviderGate: () => undefined,
    metadataCache: options.metadataCache ?? new ProviderMetadataCache({
      read: async () => ({ models: [] }),
    }),
    detectProvider: async (providerId) => options.detect(providerId),
  }, options.harness ? new AgentHarnessRegistry([options.harness]) : undefined);
  managers.push(manager);
  manager.observeInstallationEvents((event) => events.push(event));
  return { manager, leases, events };
}

function codexHarness(
  start: (options: AgentHarnessStartOptions) => Promise<ProviderRunResult>,
): AgentHarness {
  return {
    id: "codex-app-server",
    providerId: "codex",
    capabilities: CODEX_APP_SERVER_HARNESS_CAPABILITIES,
    supports: () => true,
    start: (options) => ({
      harnessId: "codex-app-server",
      providerId: "codex",
      result: start(options),
      cancel: () => undefined,
      extension: {
        kind: "codex-app-server",
        respondToApproval: () => false,
        respondToInput: () => false,
        setGoal: async () => { throw new Error("Goals are not part of this fixture."); },
        clearGoal: async () => true,
      },
    }),
  };
}

function codexInput(conversationId: string): ProviderRunInput {
  return nativeProviderRunInput({
    providerId: "codex",
    conversationId,
    runId: `${conversationId}-run`,
    turnId: `${conversationId}-turn`,
    cwd: "/workspace",
    prompt: "Reload fixture",
    interactionMode: "build",
    access: "supervised",
  });
}

function terminal(
  input: ProviderRunInput,
  status: ProviderRunResult["status"],
  cleanupConfirmed = true,
): ProviderRunResult {
  return {
    ...providerRunTerminal(input, status),
    text: "",
    textTruncated: false,
    exitCode: status === "completed" ? 0 : 1,
    signal: null,
    cleanupConfirmed,
  };
}

describe("provider installation reload", () => {
  it("lifts a discovery cleanup quarantine on the next clean detection", async () => {
    let cleanupConfirmed = false;
    const { manager, leases, events } = production({
      detect: (providerId) => detection(providerId, "/tools/claude", "1.0.0", cleanupConfirmed),
    });

    await expect(manager.detect("claude")).resolves.toMatchObject({ cleanupConfirmed: false });
    const installation = manager.providerInstallationIdentityForMaintenance("claude", "/tools/claude", "1.0.0");
    expect(leases.isQuarantined(installation)).toBe(true);
    expect(events).toEqual([{ providerId: "claude", kind: "probe-cleanup-unconfirmed" }]);

    cleanupConfirmed = true;
    await expect(manager.detect("claude")).resolves.toMatchObject({
      executable: "/tools/claude",
      cleanupConfirmed: true,
    });
    expect(leases.isQuarantined(installation)).toBe(false);
    expect(manager.providerInstallationState("claude")).toBe("current");
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("lifts the quarantine of a probe that failed with unconfirmed cleanup on the next clean detection", async () => {
    let probeFails = true;
    const { manager, leases, events } = production({
      detect: (providerId) => {
        if (probeFails) throw new ProcessTreeTerminationError("The version probe");
        return detection(providerId, "/tools/claude", "1.0.0");
      },
    });

    await expect(manager.detect("claude")).rejects.toBeInstanceOf(ProcessTreeTerminationError);
    expect(leases.hasProviderAuthority("claude")).toBe(true);
    expect(events).toEqual([{ providerId: "claude", kind: "probe-cleanup-unconfirmed" }]);

    probeFails = false;
    await expect(manager.detect("claude")).resolves.toMatchObject({ cleanupConfirmed: true });
    expect(leases.hasProviderAuthority("claude")).toBe(false);
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("lifts a metadata cleanup quarantine on the next clean detection", async () => {
    let readFails = true;
    const metadataCache = new ProviderMetadataCache({
      read: async () => {
        if (readFails) throw new ProcessTreeTerminationError("The metadata probe");
        return { models: [] };
      },
    });
    const { manager, leases, events } = production({
      metadataCache,
      detect: (providerId) => detection(providerId, "/tools/claude", "1.0.0"),
    });

    await manager.detect("claude");
    await manager.metadata("claude", "/workspace", { force: true });
    const installation = manager.providerInstallationIdentityForMaintenance("claude", "/tools/claude", "1.0.0");
    expect(leases.isQuarantined(installation)).toBe(true);
    expect(events).toEqual([{ providerId: "claude", kind: "probe-cleanup-unconfirmed" }]);

    readFails = false;
    await expect(manager.detect("claude")).resolves.toMatchObject({ cleanupConfirmed: true });
    await manager.metadata("claude", "/workspace", { force: true });
    expect(leases.isQuarantined(installation)).toBe(false);
    expect(manager.providerInstallationState("claude")).toBe("current");
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("admits a moved bare PATH installation as the replacement when nothing uses the old one", async () => {
    let current = detection("claude", "/tools/claude-v1", "1.0.0");
    const metadataCache = new ProviderMetadataCache({ read: async () => ({ models: [] }) });
    const { manager, leases } = production({ metadataCache, detect: () => current });

    await manager.detect("claude");
    const previousFingerprint = manager.providerInstallationFingerprint("claude");
    current = detection("claude", "/tools/claude-v2", "2.0.0");

    await expect(manager.detect("claude")).resolves.toMatchObject({
      executable: "/tools/claude-v2",
      version: "2.0.0",
    });
    expect(manager.providerInstallationState("claude")).toBe("current");
    expect(manager.providerInstallationFingerprint("claude")).not.toBe(previousFingerprint);
    expect(metadataCache.nativeScope("claude")).toMatchObject({
      executable: "/tools/claude-v2",
      version: "2.0.0",
    });
    for (const [executable, version] of [["/tools/claude-v1", "1.0.0"], ["/tools/claude-v2", "2.0.0"]] as const) {
      const installation = manager.providerInstallationIdentityForMaintenance("claude", executable, version);
      expect(leases.isQuarantined(installation)).toBe(false);
      expect(leases.blockers(installation)).toEqual([]);
    }
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("rejects a moved installation on every detection while a run of the old one is active and admits it after that run settles", async () => {
    let current = detection("codex", "/tools/codex-v1", "1.0.0");
    const finished = deferred<ProviderRunResult>();
    const { manager } = production({
      detect: () => current,
      harness: codexHarness(async () => await finished.promise),
    });
    await manager.detect("codex");
    const input = codexInput("moved-while-running");
    const result = manager.run(input);
    current = detection("codex", "/tools/codex-v2", "2.0.0");

    await expect(manager.detect("codex")).rejects.toMatchObject({ code: "lifecycle_corruption" });
    await expect(manager.detect("codex")).rejects.toMatchObject({ code: "lifecycle_corruption" });
    expect(manager.isRunning(input.conversationId)).toBe(true);

    finished.resolve(terminal(input, "completed"));
    await expect(result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
    await expect(manager.detect("codex")).resolves.toMatchObject({ executable: "/tools/codex-v2" });
    expect(manager.providerInstallationState("codex")).toBe("current");
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("lifts a sign-in quarantine on Refresh when the provider has no active run", async () => {
    const { manager, leases } = production({
      detect: (providerId) => detection(providerId, "/tools/claude", "1.0.0"),
    });
    await manager.detect("claude");
    const launch = await manager.authLaunch("claude", "/workspace");
    expect(launch.installationUse.accept()?.quarantine("terminal-provider-cleanup-unconfirmed")).toBe(true);
    const installation = manager.providerInstallationIdentityForMaintenance("claude", "/tools/claude", "1.0.0");
    expect(leases.isQuarantined(installation)).toBe(true);
    await expect(manager.detect("claude")).rejects.toThrow(
      "The provider installation is paused because an earlier provider process could not be confirmed stopped. Open Settings > Agents and choose Refresh all providers.",
    );

    manager.recoverInstallation("claude");

    await expect(manager.detect("claude")).resolves.toMatchObject({ cleanupConfirmed: true });
    expect(leases.isQuarantined(installation)).toBe(false);
    expect(manager.providerInstallationState("claude")).toBe("current");
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("lets the user change the configured command after a sign-in quarantine", async () => {
    const { manager } = production({
      detect: (providerId) => detection(providerId, "/tools/codex", "1.0.0"),
    });
    await manager.detect("codex");
    const launch = await manager.authLaunch("codex", "/workspace");
    launch.installationUse.accept()?.quarantine("terminal-provider-cleanup-unconfirmed");

    expect(() => manager.setCommand("codex", "/tools/codex")).not.toThrow();
    await expect(manager.detect("codex")).resolves.toMatchObject({ cleanupConfirmed: true });
  });

  it("keeps the quarantine of a run that is still active on Refresh", async () => {
    const { manager, leases } = production({
      detect: (providerId) => detection(providerId, "/tools/codex", "1.0.0"),
      harness: codexHarness(async (options) => terminal({ ...options.input, runId: "another-run" }, "completed")),
    });
    await manager.detect("codex");
    const input = codexInput("mismatched-owner");
    await expect(manager.run(input)).rejects.toMatchObject({ code: "lifecycle_corruption" });
    expect(manager.isRunning(input.conversationId)).toBe(true);
    const installation = manager.providerInstallationIdentityForMaintenance("codex", "/tools/codex", "1.0.0");
    expect(leases.isQuarantined(installation)).toBe(true);

    manager.recoverInstallation("codex");

    expect(leases.isQuarantined(installation)).toBe(true);
    await expect(manager.detect("codex")).rejects.toBeInstanceOf(ProviderInstallationAdmissionError);
  }, 30_000);

  it("never lifts a maintenance quarantine on Refresh", async () => {
    const { manager, leases } = production({
      detect: (providerId) => detection(providerId, "/tools/claude", "1.0.0"),
    });
    await manager.detect("claude");
    const installation = manager.providerInstallationIdentityForMaintenance("claude", "/tools/claude", "1.0.0");
    const maintenance = await leases.acquireMaintenance(installation, { operationId: "update-claude" });
    expect(maintenance.quarantine("maintenance-terminal-receipt-mismatch")).toBe(true);

    manager.recoverInstallation("claude");

    expect(leases.isQuarantined(installation)).toBe(true);
    await expect(manager.detect("claude")).rejects.toThrow(
      "The provider installation is unavailable while maintenance owns it.",
    );
  });

  it("asks for rediscovery when a run fails before its provider handshake", async () => {
    let handshake = false;
    const { manager, events } = production({
      detect: (providerId) => detection(providerId, "/tools/codex", "1.0.0"),
      harness: codexHarness(async (options) => {
        if (handshake) {
          createAgentHarnessEmitter(
            "codex",
            options.input.conversationId,
            options.callbacks,
            options.input.runId,
            options.input.turnId,
          ).session("thread-1");
        }
        return terminal(options.input, "failed");
      }),
    });
    await manager.detect("codex");

    await expect(manager.run(codexInput("spawn-failed"))).resolves.toMatchObject({ status: "failed" });
    await vi.waitFor(() => {
      expect(events).toEqual([{ providerId: "codex", kind: "run-start-failed" }]);
    });
    handshake = true;
    await expect(manager.run(codexInput("failed-after-handshake"))).resolves.toMatchObject({ status: "failed" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([{ providerId: "codex", kind: "run-start-failed" }]);
  });

  it("asks for rediscovery when a run is released with unconfirmed cleanup", async () => {
    const onRunCleanupUnconfirmed = vi.fn();
    const leases = new ProviderInstallationLeaseCoordinator();
    const manager = ProviderManager.createProduction({
      installationLeases: leases,
      conversationProviderGate: () => undefined,
      cancelGraceMs: 100,
      onRunCleanupUnconfirmed,
      metadataCache: new ProviderMetadataCache({ read: async () => ({ models: [] }) }),
      detectProvider: async (providerId) => detection(providerId, "/tools/codex", "1.0.0"),
    }, new AgentHarnessRegistry([codexHarness(async (options) => terminal(options.input, "completed", false))]));
    managers.push(manager);
    const events: ProviderInstallationEvent[] = [];
    manager.observeInstallationEvents((event) => events.push(event));
    await manager.detect("codex");
    const input = codexInput("released-unconfirmed");

    await manager.run(input);
    await expect(manager.stopOwned(input.conversationId, input)).resolves.toBe("force-detached");

    expect(onRunCleanupUnconfirmed).toHaveBeenCalledWith(expect.objectContaining({ providerId: "codex" }), undefined);
    expect(events).toEqual([{ providerId: "codex", kind: "run-cleanup-unconfirmed" }]);
  });
});
