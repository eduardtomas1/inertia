// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentHarnessRegistry,
  ProviderManager,
  type AgentHarness,
  type ProviderManagerDetectionOptions,
  type ProviderId,
  type ProviderInstallationEvent,
} from "../../src/server/providers";
import { createProviderInfoRefresh } from "../../src/server/provider/provider-info-refresh";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";
import { CLAUDE_AGENT_SDK_CAPABILITIES } from "../../src/server/provider/claude-agent-sdk-harness";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import {
  providerRunTerminal,
  type ProviderRunIdentity,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  ProviderInstallationLeaseCoordinator,
  providerInstallationIdentity,
} from "../../src/server/provider/installation-lease";
import { forceTerminationBudgetMs } from "../../src/server/process-lifecycle";
import {
  DEFAULT_PROVIDER_CANCEL_GRACE_MS,
  PROVIDER_SHUTDOWN_RESERVE_MS,
  PROVIDER_SHUTDOWN_STOP_GRACE_MS,
  providerCleanupIncident,
} from "../../src/server/provider/run-cleanup-settlement";
import { runtimeShutdownDeadlineMs } from "../../src/node/runtime-shutdown-deadline";
import { createIncidentReporter } from "../../src/node/application-incidents";
import type { DiagnosticIncident } from "../../src/shared/application-diagnostics";
import { nativeProviderRunInput } from "./model-route-fixture";

const VERSION = "2.1.269";

interface HarnessPlan {
  cleanupConfirmed: boolean;
  cleanupConfirmation?: Promise<boolean>;
  never?: boolean;
  release?: Promise<void>;
}

function claudeInput(
  runId: string,
  conversationId = "claude-cleanup-settlement",
): ProviderRunInput {
  return nativeProviderRunInput({
    providerId: "claude",
    conversationId,
    runId,
    turnId: `${runId}-turn`,
    cwd: "/workspace",
    prompt: "Inspect this project",
    interactionMode: "build",
    access: "supervised",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function settlementFixture(
  plans: HarnessPlan[],
  stopBudget: { cancelGraceMs?: number; forceStopBudgetMs?: number } = {},
  probeGate: () => Promise<void> = async () => undefined,
) {
  const cancel = vi.fn();
  const harness: AgentHarness = {
    id: "claude-agent-sdk",
    providerId: "claude",
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
    supports: () => true,
    start: (options) => {
      const plan = plans.shift() ?? { cleanupConfirmed: true };
      const emitter = createAgentHarnessEmitter(
        "claude",
        options.input.conversationId,
        options.callbacks,
        options.input.runId,
        options.input.turnId,
      );
      emitter.text("Done.");
      const result: Promise<ProviderRunResult> = plan.never
        ? new Promise(() => undefined)
        : (plan.release ?? Promise.resolve()).then(() => ({
            ...providerRunTerminal(options.input, "completed"),
            text: "Done.",
            textTruncated: false,
            exitCode: 0,
            signal: null,
            cleanupConfirmed: plan.cleanupConfirmed,
            ...(plan.cleanupConfirmation ? { cleanupConfirmation: plan.cleanupConfirmation } : {}),
          }));
      return {
        harnessId: "claude-agent-sdk",
        providerId: "claude",
        cancel,
        extension: {
          kind: "claude-agent-sdk",
          respondToApproval: () => false,
          respondToInput: () => false,
          steer: async () => false,
        },
        result,
      };
    },
  };
  const leases = new ProviderInstallationLeaseCoordinator();
  const unconfirmed: ProviderRunIdentity[] = [];
  const confirmedLate: ProviderRunIdentity[] = [];
  const manager = ProviderManager.createForTests(
    {
      commands: { claude: "/tools/claude" },
      cancelGraceMs: stopBudget.cancelGraceMs ?? 100,
      forceStopBudgetMs: stopBudget.forceStopBudgetMs,
      installationLeases: leases,
      onRunCleanupUnconfirmed: (identity) => unconfirmed.push(identity),
      onRunCleanupConfirmedLate: (identity) => confirmedLate.push(identity),
      detectProvider: async () => {
        await probeGate();
        return {
        provider: { id: "claude", name: "claude", command: "claude" },
        available: true,
        version: VERSION,
        executable: "/tools/claude",
        installState: "installed" as const,
        authState: "authenticated" as const,
        canRun: true,
        cleanupConfirmed: true,
        };
      },
    },
    new AgentHarnessRegistry([harness]),
  );
  const installation = () => manager.providerInstallationIdentityForMaintenance(
    "claude",
    "/tools/claude",
    VERSION,
  );
  return { manager, leases, unconfirmed, confirmedLate, cancel, installation };
}

const conversationId = "claude-cleanup-settlement";
const owner = (runId: string) => ({ runId, turnId: `${runId}-turn` });

afterEach(() => {
  vi.useRealTimers();
});

describe("provider run cleanup settlement", () => {
  it("settles an unconfirmed result once cleanup is confirmed late and rediscovers the provider for the next run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const late = deferred<boolean>();
    const fixture = settlementFixture([
      { cleanupConfirmed: false, cleanupConfirmation: late.promise },
      { cleanupConfirmed: true },
    ]);
    const { manager } = fixture;
    const events: ProviderInstallationEvent[] = [];
    manager.observeInstallationEvents((event) => events.push(event));
    const lifetime = new AbortController();
    let providerInfo = initialProviderSnapshots();
    createProviderInfoRefresh({
      enabled: true,
      providers: {
        detect: (providerId: ProviderId, options: ProviderManagerDetectionOptions) =>
          manager.detect(providerId, { ...options, refreshEnvironment: false }),
        observeInstallationEvents: (listener: (event: ProviderInstallationEvent) => void) =>
          manager.observeInstallationEvents(listener),
        providerInstallationState: (providerId: ProviderId) =>
          manager.providerInstallationState(providerId),
        cachedMetadata: (providerId: ProviderId) => manager.cachedMetadata(providerId),
        metadata: async (providerId: ProviderId) => manager.cachedMetadata(providerId),
        metadataReadTimedOut: () => false,
        providerCapabilityContract: () => undefined,
      } as unknown as ProviderManager,
      defaultWorkspacePath: "/workspace",
      lifetimeSignal: lifetime.signal,
      providerInfo: () => providerInfo,
      replaceProviderInfo: (value) => { providerInfo = value; },
      broadcastSnapshot: () => undefined,
      isClosed: () => lifetime.signal.aborted,
      track: async (operation) => await operation(),
      onActivityChange: () => undefined,
    });
    await manager.detect("claude");

    await expect(manager.run(claudeInput("run-1"))).resolves.toMatchObject({
      cleanupConfirmed: false,
    });
    expect(manager.isRunning(conversationId)).toBe(true);
    expect(fixture.leases.isQuarantined(fixture.installation())).toBe(true);

    const stop = manager.stopOwned(conversationId, owner("run-1"));
    late.resolve(true);
    await expect(stop).resolves.toBe("settled");
    expect(manager.isRunning(conversationId)).toBe(false);
    expect(fixture.leases.isQuarantined(fixture.installation())).toBe(false);
    expect(fixture.unconfirmed).toEqual([]);
    expect(events).toEqual([{ providerId: "claude", kind: "run-cleanup-unconfirmed" }]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.providerInstallationState("claude")).toBe("current");
    await expect(manager.run(claudeInput("run-2"))).resolves.toMatchObject({
      status: "completed",
      cleanupConfirmed: true,
    });
    lifetime.abort();
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("detaches an unconfirmed result when late cleanup fails, records an incident and admits the next run", async () => {
    const late = deferred<boolean>();
    const fixture = settlementFixture([
      { cleanupConfirmed: false, cleanupConfirmation: late.promise },
      { cleanupConfirmed: true },
    ]);
    const { manager } = fixture;
    await manager.detect("claude");

    await manager.run(claudeInput("run-1"));
    const stop = manager.stopOwned(conversationId, owner("run-1"));
    late.resolve(false);
    await expect(stop).resolves.toBe("force-detached");
    expect(manager.isRunning(conversationId)).toBe(false);
    expect(fixture.leases.isQuarantined(fixture.installation())).toBe(false);
    expect(fixture.unconfirmed).toEqual([expect.objectContaining({
      providerId: "claude",
      conversationId,
      runId: "run-1",
      turnId: "run-1-turn",
    })]);
    await expect(manager.stopOwned(conversationId, owner("run-1")))
      .resolves.toBe("force-detached");

    await manager.detect("claude");
    await expect(manager.run(claudeInput("run-2"))).resolves.toMatchObject({
      status: "completed",
    });
    await expect(manager.disposeAll()).rejects.toThrow(
      "Provider process cleanup could not be confirmed",
    );
  });

  it("detaches an unconfirmed result without a late confirmation", async () => {
    const fixture = settlementFixture([{ cleanupConfirmed: false }]);
    const { manager } = fixture;
    await manager.detect("claude");

    await manager.run(claudeInput("run-1"));
    await expect(manager.stopOwned(conversationId, owner("run-1")))
      .resolves.toBe("force-detached");
    expect(manager.isRunning(conversationId)).toBe(false);
    expect(fixture.unconfirmed).toHaveLength(1);
  });

  it("force-detaches a harness that ignores cancellation within the platform stop budget", async () => {
    const fixture = settlementFixture([{ cleanupConfirmed: true, never: true }]);
    const { manager } = fixture;
    await manager.detect("claude");
    vi.useFakeTimers();

    void manager.run(claudeInput("run-1"));
    let outcome: string | null = null;
    void manager.stopOwned(conversationId, owner("run-1")).then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.cancel).toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(forceTerminationBudgetMs(process.platform) - 1);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("force-detached");
    expect(manager.isRunning(conversationId)).toBe(false);
    expect(fixture.leases.isQuarantined(fixture.installation())).toBe(false);
    expect(fixture.unconfirmed).toHaveLength(1);
  });

  it("escalates an in-flight stop to the force step when a forced stop is requested", async () => {
    const fixture = settlementFixture([{ cleanupConfirmed: true, never: true }]);
    const { manager } = fixture;
    await manager.detect("claude");
    vi.useFakeTimers();

    void manager.run(claudeInput("run-1"));
    const graceful = manager.stopOwned(conversationId, owner("run-1"), 10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.cancel).toHaveBeenCalledWith(false);
    expect(fixture.cancel).not.toHaveBeenCalledWith(true);

    const forced = manager.stopOwned(conversationId, owner("run-1"), 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.cancel).toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(forceTerminationBudgetMs(process.platform));
    await expect(graceful).resolves.toBe("force-detached");
    await expect(forced).resolves.toBe("force-detached");
  });

  it("reports a late cleanup confirmation that arrives after the stop force-detached the run", async () => {
    const late = deferred<boolean>();
    const fixture = settlementFixture([
      { cleanupConfirmed: false, cleanupConfirmation: late.promise },
    ]);
    const { manager } = fixture;
    await manager.detect("claude");
    vi.useFakeTimers();

    await manager.run(claudeInput("run-1"));
    const stop = manager.stopOwned(conversationId, owner("run-1"));
    await vi.advanceTimersByTimeAsync(100 + forceTerminationBudgetMs(process.platform));
    await expect(stop).resolves.toBe("force-detached");
    expect(fixture.confirmedLate).toEqual([]);

    late.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.confirmedLate).toEqual([expect.objectContaining({
      providerId: "claude",
      conversationId,
      runId: "run-1",
      turnId: "run-1-turn",
    })]);
    await expect(manager.stopOwned(conversationId, owner("run-1"))).resolves.toBe("settled");
  });

  it("does not report a late cleanup confirmation that fails after the stop force-detached the run", async () => {
    const late = deferred<boolean>();
    const fixture = settlementFixture([
      { cleanupConfirmed: false, cleanupConfirmation: late.promise },
    ]);
    const { manager } = fixture;
    await manager.detect("claude");
    vi.useFakeTimers();

    await manager.run(claudeInput("run-1"));
    const stop = manager.stopOwned(conversationId, owner("run-1"));
    await vi.advanceTimersByTimeAsync(100 + forceTerminationBudgetMs(process.platform));
    await expect(stop).resolves.toBe("force-detached");

    late.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.confirmedLate).toEqual([]);
    await expect(manager.stopOwned(conversationId, owner("run-1")))
      .resolves.toBe("force-detached");
  });

  it("reports a provider result with confirmed cleanup that arrives after the stop force-detached the run", async () => {
    const release = deferred<void>();
    const fixture = settlementFixture([
      { cleanupConfirmed: true, release: release.promise },
    ]);
    const { manager } = fixture;
    await manager.detect("claude");
    vi.useFakeTimers();

    const result = manager.run(claudeInput("run-1"));
    const stop = manager.stopOwned(conversationId, owner("run-1"));
    await vi.advanceTimersByTimeAsync(100 + forceTerminationBudgetMs(process.platform));
    await expect(stop).resolves.toBe("force-detached");
    expect(fixture.confirmedLate).toEqual([]);

    release.resolve();
    await expect(result).resolves.toMatchObject({ cleanupConfirmed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.confirmedLate).toEqual([expect.objectContaining({
      conversationId,
      runId: "run-1",
      turnId: "run-1-turn",
    })]);
  });

  it("disposes three runs that ignore Stop within the Linux runtime shutdown deadline", async () => {
    const fixture = settlementFixture(
      [1, 2, 3].map(() => ({ cleanupConfirmed: true, never: true })),
      {
        cancelGraceMs: DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        forceStopBudgetMs: forceTerminationBudgetMs("linux"),
      },
    );
    const { manager } = fixture;
    await manager.detect("claude");
    vi.useFakeTimers();
    const conversations = ["shutdown-a", "shutdown-b", "shutdown-c"];
    conversations.forEach((id, index) => {
      void manager.run(claudeInput(`run-${index + 1}`, id));
    });
    const stops = [
      manager.stopOwned(conversations[0]!, owner("run-1")),
    ];
    await vi.advanceTimersByTimeAsync(500);

    const startedAt = Date.now();
    const deadlineAt = startedAt + runtimeShutdownDeadlineMs("linux");
    manager.beginShutdown(deadlineAt);
    stops.push(
      manager.stopOwned(conversations[1]!, owner("run-2")),
      manager.stopOwned(conversations[2]!, owner("run-3")),
    );
    let disposedAt: number | null = null;
    const disposed = manager.disposeAll().finally(() => {
      disposedAt = Date.now();
    });
    disposed.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(deadlineAt - startedAt);
    await expect(disposed).rejects.toThrow("Provider process cleanup could not be confirmed");
    expect(disposedAt).not.toBeNull();
    expect(disposedAt!).toBeLessThanOrEqual(deadlineAt - PROVIDER_SHUTDOWN_RESERVE_MS);
    await expect(Promise.all(stops)).resolves.toEqual([
      "force-detached",
      "force-detached",
      "force-detached",
    ]);
    expect(fixture.cancel.mock.calls.filter(([force]) => force === true).length)
      .toBeGreaterThanOrEqual(3);
    expect(conversations.some((id) => manager.isRunning(id))).toBe(false);
    expect(fixture.unconfirmed).toHaveLength(3);
  });

  it("stops waiting for an in-flight probe at quit before the runtime shutdown deadline", async () => {
    let holdProbe = false;
    let probing = false;
    const fixture = settlementFixture([], {}, () => {
      if (!holdProbe) return Promise.resolve();
      probing = true;
      return new Promise<void>(() => undefined);
    });
    const { manager } = fixture;
    await manager.detect("claude");
    vi.useFakeTimers();
    holdProbe = true;
    void manager.detect("claude").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(probing).toBe(true);

    const startedAt = Date.now();
    const deadlineAt = startedAt + runtimeShutdownDeadlineMs("linux");
    manager.beginShutdown(deadlineAt);
    let disposedAt: number | null = null;
    const disposed = manager.disposeAll().finally(() => {
      disposedAt = Date.now();
    });
    disposed.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(deadlineAt - startedAt);
    await expect(disposed).rejects.toThrow(
      "Provider process cleanup could not be confirmed. Unconfirmed: in-flight provider probes.",
    );
    expect(disposedAt).not.toBeNull();
    expect(disposedAt!).toBeLessThanOrEqual(deadlineAt - PROVIDER_SHUTDOWN_RESERVE_MS);
  });

  it("uses at most one second of graceful stop once runtime shutdown has begun", async () => {
    const fixture = settlementFixture(
      [{ cleanupConfirmed: true, never: true }],
      {
        cancelGraceMs: DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        forceStopBudgetMs: forceTerminationBudgetMs("linux"),
      },
    );
    const { manager } = fixture;
    await manager.detect("claude");
    vi.useFakeTimers();

    void manager.run(claudeInput("run-1"));
    manager.beginShutdown(Date.now() + runtimeShutdownDeadlineMs("linux"));
    void manager.stopOwned(conversationId, owner("run-1"));
    await vi.advanceTimersByTimeAsync(PROVIDER_SHUTDOWN_STOP_GRACE_MS - 1);
    expect(fixture.cancel).not.toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.cancel).toHaveBeenCalledWith(true);
  });
});

describe("provider cleanup incident", () => {
  it("records an unconfirmed provider cleanup as a scoped diagnostic incident", () => {
    const incidents: DiagnosticIncident[] = [];
    const report = createIncidentReporter((incident) => incidents.push(incident));
    const conversation = "8f0c5f8e-4e44-4f53-9b51-0f2f0a6f2d11";
    const turn = "3b6f3e2a-1c1d-4a52-8d0a-6a1f9b9b7c21";

    report(providerCleanupIncident({
      providerId: "claude",
      conversationId: conversation,
      runId: "run-1",
      turnId: turn,
    }));
    report(providerCleanupIncident({
      providerId: "codex",
      conversationId: "isolated-review",
      runId: "run-2",
      turnId: "turn-2",
    }));

    expect(incidents).toEqual([
      expect.objectContaining({
        code: "provider.cleanup-unconfirmed",
        outcome: "unknown",
        context: { providerId: "claude", conversationId: conversation, turnId: turn },
      }),
      expect.objectContaining({
        code: "provider.cleanup-unconfirmed",
        context: { providerId: "codex" },
      }),
    ]);
  });
});

describe("provider installation quarantine lift", () => {
  function identity(executable = "/tools/claude") {
    return providerInstallationIdentity({
      providerId: "claude",
      executable,
      installationRootIdentity: "provider-managed:claude",
      packageIdentity: null,
      version: "1.0.0",
      environmentIdentity: "runtime-provider-environment",
      replacementBoundaryIdentity: "/tools/claude",
    });
  }

  it("lifts only the quarantine created by the same operation", () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const installation = identity();
    const use = leases.acquireUse(installation, {
      kind: "provider-run",
      operationId: "run-quarantined",
    });
    expect(use.quarantine("provider-run-cleanup-unconfirmed")).toBe(true);
    expect(leases.isQuarantined(installation)).toBe(true);

    expect(leases.liftQuarantine(installation, "another-run")).toBe(false);
    expect(leases.isQuarantined(installation)).toBe(true);
    expect(leases.liftQuarantine(installation, "run-quarantined")).toBe(true);
    expect(leases.isQuarantined(installation)).toBe(false);
    expect(leases.blockers(installation)).toEqual([]);
    const next = leases.acquireUse(installation, {
      kind: "provider-run",
      operationId: "run-next",
    });
    expect(next.release({ cleanupConfirmed: true })).toBe(true);
  });

  it("keeps another scope's quarantine on the same boundary after a lift", () => {
    const leases = new ProviderInstallationLeaseCoordinator();
    const first = identity("/tools/claude");
    const second = identity("/tools/claude-next");
    leases.acquireUse(first, { kind: "provider-run", operationId: "run-a" })
      .quarantine("provider-run-cleanup-unconfirmed");
    leases.quarantineObservation(second, {
      kind: "provider-run",
      operationId: "run-b",
    }, "provider-discovery-crossed-installation-authority");

    expect(leases.liftQuarantine(first, "run-a")).toBe(true);
    expect(leases.isQuarantined(first)).toBe(true);
    expect(leases.isQuarantined(second)).toBe(true);
    expect(leases.liftQuarantine(second, "run-b")).toBe(true);
    expect(leases.isQuarantined(first)).toBe(false);
  });
});
