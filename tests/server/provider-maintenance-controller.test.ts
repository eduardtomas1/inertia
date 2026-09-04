import { describe, expect, it, vi } from "vitest";

import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "../../src/shared/provider-maintenance";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceTarget,
} from "../../src/server/provider/maintenance-capabilities";
import {
  ProviderMaintenanceController,
  ProviderMaintenanceError,
} from "../../src/server/provider/maintenance-controller";
import { ProviderLatestVersionCache } from "../../src/server/provider/maintenance-latest";
import type {
  ProviderMaintenanceRunResult,
} from "../../src/server/provider/maintenance-runner";
import { providerInstallationIdentity } from
  "../../src/server/provider/installation-lease";
import { providerMaintenanceJournalTestDouble } from
  "../support/provider-maintenance-journal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function target(
  providerId: ProviderMaintenanceProviderId,
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
  providerId: ProviderMaintenanceProviderId,
  lockKey = "shared-manager",
  packageName: string | null = null,
): ProviderMaintenanceCapabilities {
  return {
    providerId,
    packageName,
    installMethod: "provider-managed",
    updateAvailability: "available",
    update: {
      executable: `/tools/${providerId}`,
      args: [providerId === "opencode" ? "upgrade" : "update"],
      lockKey,
      installMethod: "provider-managed",
      label: `Update ${providerId}`,
    },
    instructionsUrl: "https://example.test/update",
  };
}

function success(
  output: string | null = "updated",
): ProviderMaintenanceRunResult {
  return {
    status: "succeeded",
    exitCode: 0,
    signal: null,
    message: "Provider update command completed.",
    cleanupConfirmed: true,
    output,
    outputTruncated: false,
  };
}

function operationIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

function waitForTerminal(
  events: ProviderMaintenanceOperation[],
  operationId: string,
): Promise<ProviderMaintenanceOperation> {
  return new Promise((resolve) => {
    const inspect = (): void => {
      const event = [...events].reverse().find(
        (candidate) => candidate.id === operationId
          && ["succeeded", "unchanged", "failed", "cancelled"].includes(
            candidate.status,
          ),
      );
      if (event) {
        resolve(event);
        return;
      }
      setTimeout(inspect, 0);
    };
    inspect();
  });
}

describe("ProviderMaintenanceController", () => {
  it("rejects an update outside the active capability attestation", async () => {
    const runAction = vi.fn(async () => success());
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId),
      resolveCapabilities: async ({ providerId }) => capabilities(providerId),
      capabilityAvailable: () => false,
      runAction,
    });

    await expect(controller.startUpdate("claude")).rejects.toThrow(
      "capability contract does not authorize",
    );
    expect(runAction).not.toHaveBeenCalled();
    expect(controller.hasBlockingAuthority("claude")).toBe(false);
  });

  it("accepts a re-resolved executable only within its stable replacement boundary", async () => {
    let current = target("claude", "1.0.0", "/tools/claude-v1");
    const operations: ProviderMaintenanceOperation[] = [];
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: () => current,
      refreshTarget: async () => current,
      resolveCapabilities: async () => capabilities("claude"),
      installationIdentity: (subject) => providerInstallationIdentity({
        providerId: subject.providerId,
        executable: subject.executable,
        installationRootIdentity: null,
        packageIdentity: "provider-managed:claude",
        version: subject.installedVersion,
        replacementBoundaryIdentity: "/configured/claude",
      }),
      runAction: async () => {
        current = target("claude", "2.0.0", "/tools/claude-v2");
        return success();
      },
      onOperation: (operation) => operations.push(operation),
    });

    const operation = await controller.startUpdate("claude");
    await expect(waitForTerminal(operations, operation.id)).resolves
      .toMatchObject({ status: "succeeded", afterVersion: "2.0.0" });
    expect(controller.hasBlockingAuthority("claude")).toBe(false);
  });

  it("closes only the reserved provider configuration before async capability resolution", async () => {
    const capabilityGate = deferred<ProviderMaintenanceCapabilities>();
    const operations: ProviderMaintenanceOperation[] = [];
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId, "2.0.0"),
      resolveCapabilities: async () => await capabilityGate.promise,
      runAction: async () => success(),
      operationId: () => "provider-reservation",
      onOperation: (operation) => operations.push(operation),
    });

    const started = controller.startUpdate("claude");
    expect(controller.hasBlockingAuthority("claude")).toBe(true);
    expect(controller.hasBlockingAuthority("opencode")).toBe(false);
    capabilityGate.resolve(capabilities("claude"));
    const operation = await started;
    await waitForTerminal(operations, operation.id);
  });

  it("emits queued, running and verified success without hiding progress", async () => {
    let current = target("claude");
    const operations: ProviderMaintenanceOperation[] = [];
    const statuses: string[] = [];
    const latest = new ProviderLatestVersionCache({
      fetch: (async () => new Response(
        JSON.stringify({ version: "2.0.0" }),
        { status: 200 },
      )) as typeof fetch,
    });
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: () => current,
      refreshTarget: async () => {
        current = target("claude", "2.0.0");
        return current;
      },
      latestVersions: latest,
      resolveCapabilities: async () => capabilities(
        "claude",
        "claude",
        "@anthropic-ai/claude-code",
      ),
      runAction: async (_action, options) => {
        options.onProgress({
          output: "Downloading update",
          outputTruncated: false,
        });
        return success();
      },
      operationId: operationIds(),
      onStatus: (status) => statuses.push(status.versionStatus),
      onOperation: (operation) => operations.push(operation),
    });

    const started = await controller.startUpdate("claude");
    const terminal = await waitForTerminal(operations, started.id);

    expect(operations.map(({ status }) => status)).toEqual([
      "queued",
      "running",
      "running",
      "succeeded",
    ]);
    expect(operations[2]?.output).toBe("Downloading update");
    expect(terminal).toMatchObject({
      status: "succeeded",
      beforeVersion: "1.0.0",
      afterVersion: "2.0.0",
      targetVersion: "2.0.0",
    });
    expect(statuses).toEqual(["update-available", "current"]);
  });

  it("projects active updates without replaying command output after reconnect", async () => {
    const pending = deferred<ProviderMaintenanceRunResult>();
    const operations: ProviderMaintenanceOperation[] = [];
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId),
      resolveCapabilities: async ({ providerId }) => capabilities(providerId),
      runAction: async (_action, options) => {
        options.onProgress({
          output: "private command output",
          outputTruncated: true,
        });
        return await pending.promise;
      },
      operationId: operationIds(),
      onOperation: (operation) => operations.push(operation),
    });

    const started = await controller.startUpdate("claude");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.activeOperations()).toEqual([expect.objectContaining({
      id: started.id,
      providerId: "claude",
      status: "running",
      message: "Updating provider.",
      output: null,
      outputTruncated: false,
    })]);
    expect(controller.operation(started.id)?.output).toBe(
      "private command output",
    );

    controller.cancel(started.id);
    pending.resolve({
      ...success(),
      status: "cancelled",
      message: "Provider update cancelled.",
    });
    await waitForTerminal(operations, started.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.activeOperations()).toEqual([]);
  });

  it("serializes different providers sharing one package-manager lock", async () => {
    const first = deferred<ProviderMaintenanceRunResult>();
    const calls: ProviderMaintenanceProviderId[] = [];
    const operations: ProviderMaintenanceOperation[] = [];
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId, "2.0.0"),
      resolveCapabilities: async ({ providerId }) => capabilities(providerId),
      runAction: async (action) => {
        const providerId = action.executable.endsWith("claude")
          ? "claude"
          : "opencode";
        calls.push(providerId);
        return providerId === "claude" ? await first.promise : success();
      },
      operationId: operationIds(),
      onOperation: (operation) => operations.push(operation),
    });

    const claude = await controller.startUpdate("claude");
    const opencode = await controller.startUpdate("opencode");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["claude"]);
    expect(controller.operation(opencode.id)?.status).toBe("queued");

    first.resolve(success());
    await waitForTerminal(operations, claude.id);
    await waitForTerminal(operations, opencode.id);
    expect(calls).toEqual(["claude", "opencode"]);
  });

  it("cancels a queued operation without starting its command", async () => {
    const first = deferred<ProviderMaintenanceRunResult>();
    const calls: ProviderMaintenanceProviderId[] = [];
    const operations: ProviderMaintenanceOperation[] = [];
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId),
      resolveCapabilities: async ({ providerId }) => capabilities(providerId),
      runAction: async (action) => {
        const providerId = action.executable.endsWith("claude")
          ? "claude"
          : "opencode";
        calls.push(providerId);
        return providerId === "claude" ? await first.promise : success();
      },
      operationId: operationIds(),
      onOperation: (operation) => operations.push(operation),
    });

    const claude = await controller.startUpdate("claude");
    const opencode = await controller.startUpdate("opencode");
    controller.cancel(opencode.id);

    expect(await waitForTerminal(operations, opencode.id)).toMatchObject({
      status: "cancelled",
      startedAt: null,
    });
    expect(calls).toEqual(["claude"]);
    first.resolve(success());
    await waitForTerminal(operations, claude.id);
  });

  it("rejects duplicate provider updates and instructions-only installations", async () => {
    const pending = deferred<ProviderMaintenanceRunResult>();
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId),
      resolveCapabilities: async ({ providerId }) => (
        providerId === "codex"
          ? {
              ...capabilities(providerId),
              updateAvailability: "instructions-only",
              update: null,
            }
          : capabilities(providerId)
      ),
      runAction: async () => await pending.promise,
      operationId: operationIds(),
    });

    const active = await controller.startUpdate("claude");
    await expect(controller.startUpdate("claude")).rejects.toBeInstanceOf(
      ProviderMaintenanceError,
    );
    await expect(controller.startUpdate("codex")).rejects.toThrow(
      "cannot be updated safely",
    );
    controller.cancel(active.id);
    pending.resolve({
      ...success(),
      status: "cancelled",
      message: "Provider update cancelled.",
    });
    await controller.dispose();
  });

  it("reserves a provider while its update capability is being resolved", async () => {
    const capability = deferred<ProviderMaintenanceCapabilities>();
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId),
      resolveCapabilities: async () => await capability.promise,
      runAction: async () => success(),
      operationId: operationIds(),
    });

    const first = controller.startUpdate("claude");
    await expect(controller.startUpdate("claude")).rejects.toThrow(
      "already running",
    );
    capability.resolve(capabilities("claude"));
    const started = await first;
    await controller.dispose();
    expect(started.providerId).toBe("claude");
  });

  it("aborts and awaits owned operations during disposal", async () => {
    const operations: ProviderMaintenanceOperation[] = [];
    const runAction = vi.fn(async (
      _action: unknown,
      options: { signal: AbortSignal },
    ): Promise<ProviderMaintenanceRunResult> => await new Promise((resolve) => {
      options.signal.addEventListener("abort", () => resolve({
        ...success(null),
        status: "cancelled",
        message: "Provider update cancelled.",
      }), { once: true });
    }));
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId),
      resolveCapabilities: async ({ providerId }) => capabilities(providerId),
      runAction,
      operationId: operationIds(),
      onOperation: (operation) => operations.push(operation),
    });
    const started = await controller.startUpdate("claude");

    await vi.waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await controller.dispose();

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(await waitForTerminal(operations, started.id)).toMatchObject({
      status: "cancelled",
    });
  });

  it("keeps an unconfirmed updater cleanup latched through disposal", async () => {
    const operations: ProviderMaintenanceOperation[] = [];
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      target: (providerId) => target(providerId),
      refreshTarget: async (providerId) => target(providerId),
      resolveCapabilities: async ({ providerId }) => capabilities(providerId),
      runAction: async () => ({
        ...success(null),
        status: "failed",
        message: "Provider update cleanup could not be confirmed.",
        cleanupConfirmed: false,
      }),
      operationId: operationIds(),
      onOperation: (operation) => operations.push(operation),
    });
    const started = await controller.startUpdate("claude");

    await waitForTerminal(operations, started.id);
    const diagnosticStates = controller.diagnosticStates();
    expect(diagnosticStates).toHaveLength(5);
    expect(diagnosticStates).toContainEqual({
      providerId: "claude",
      state: "quarantined",
    });
    expect(diagnosticStates.every(
      (state) => Object.keys(state).sort().join(",") === "providerId,state",
    )).toBe(true);
    expect(JSON.stringify(diagnosticStates)).not.toContain("/tools/");
    await expect(controller.dispose()).rejects.toThrow(
      "Provider maintenance process cleanup could not be confirmed.",
    );
  });
});
