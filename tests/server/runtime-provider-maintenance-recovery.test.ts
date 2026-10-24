import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import type { ServerEvent } from "../../src/shared/contracts";

import { RuntimeCleanupReceiptJournal } from "../../src/main/runtime-cleanup-receipts";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { startRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import { ProviderManager, PROVIDER_IDS, PROVIDER_INFO } from "../../src/server/providers";
import type { ProviderDetection, ProviderId } from "../../src/server/provider/contracts";
import {
  ProviderInstallationLeaseCoordinator,
  providerInstallationIdentity,
  type ProviderInstallationIdentity,
} from "../../src/server/provider/installation-lease";
import { ProviderMaintenanceJournal } from "../../src/server/provider/maintenance-journal";
import { ProviderMaintenanceController } from "../../src/server/provider/maintenance-controller";
import { connectRuntime } from "../support/runtime-event-queue";
import { RuntimeTestCleanup } from "../support/runtime-test-cleanup";

const cleanup = new RuntimeTestCleanup();
afterEach(async () => {
  try { await cleanup.close(); }
  finally { vi.restoreAllMocks(); }
});

function profile(
  installationIdentity?: ProviderInstallationIdentity,
  providerId: ProviderId = installationIdentity?.providerId ?? "claude",
) {
  const root = mkdtempSync(join(tmpdir(), "inertia-maintenance-startup-"));
  cleanup.directories.push(root);
  const dataDirectory = join(root, "data");
  const defaultWorkspacePath = join(root, "workspace");
  mkdirSync(dataDirectory, { mode: 0o700 });
  mkdirSync(defaultWorkspacePath);
  const systemBootId = `test:${randomUUID()}`;
  const priorGeneration = `${randomUUID()}:1`;
  const runtimeGenerationId = `${randomUUID()}:1`;
  const journal = new ProviderMaintenanceJournal(dataDirectory, {
    runtimeGenerationId: priorGeneration, systemBootId,
  });
  expect(journal.begin(`interrupted-${providerId}-update`, installationIdentity ?? providerInstallationIdentity({
    providerId, executable: null, installationRootIdentity: `fixture-${providerId}`,
    packageIdentity: null, version: "2.0.0",
  }))).toBe(true);
  expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(runtimeGenerationId, systemBootId)).toBe(true);
  return { dataDirectory, defaultWorkspacePath, runtimeGenerationId, systemBootId, priorGeneration, journal };
}

async function nativeIdentity(providerId: ProviderId): Promise<ProviderInstallationIdentity> {
  const manager = ProviderManager.createProduction({
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    conversationProviderGate: () => undefined,
  });
  try {
    return manager.providerInstallationIdentityForMaintenance(providerId, process.execPath, "2.0.0");
  } finally {
    await manager.disposeAll();
  }
}

function mockProviderDiscovery(
  providerId?: ProviderId,
  override: Partial<Pick<ProviderDetection, "authState" | "canRun" | "protocolVerified" | "statusMessage">> = {},
) {
  const originalFactory = ProviderManager.createProduction;
  const detect = vi.fn(async (id: keyof typeof PROVIDER_INFO) => ({
    provider: PROVIDER_INFO[id], available: true, version: "2.0.0",
    executable: process.execPath, installState: "installed" as const,
    authState: "authenticated" as const, canRun: true, statusMessage: "Connected",
    protocolVerified: true, cleanupConfirmed: true,
    ...(id === providerId ? override : {}),
  }));
  vi.spyOn(ProviderManager, "createProduction").mockImplementation((options, registry) =>
    originalFactory({ ...options, detectProvider: detect }, registry));
  vi.spyOn(ProviderManager.prototype, "metadata").mockImplementation(async function (this: ProviderManager, id) {
    return this.cachedMetadata(id);
  });
  vi.spyOn(ProviderMaintenanceController.prototype, "refresh").mockResolvedValue([]);
  return detect;
}

it.each(PROVIDER_IDS)("isolates %s orphaned maintenance and shuts down cleanly", async (providerId) => {
  const paths = profile(undefined, providerId);
  const detect = mockProviderDiscovery();
  const runtime = await startRuntime(paths);
  cleanup.runtimes.push(runtime);
  const client = await connectRuntime(runtime.websocketUrl);
  try {
    const welcome = await client.events.next((event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome");
    expect(welcome.snapshot.providers.find(({ id }) => id === providerId)).toMatchObject({
      installState: "recovery-required", authState: "unknown", canRun: false,
    });
    await runtime.startPostReadyWork();
    const refreshed = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated"
      && event.snapshot.providers.filter(({ id }) => id !== providerId).every(({ canRun }) => canRun));
    for (const otherProvider of PROVIDER_IDS.filter((id) => id !== providerId)) {
      expect(refreshed.snapshot.providers.find(({ id }) => id === otherProvider)).toMatchObject({
        installState: "installed", authState: "authenticated", canRun: true,
      });
    }
    expect(refreshed.snapshot.providers.find(({ id }) => id === providerId)?.installState).toBe("recovery-required");
    expect(refreshed.snapshot.lifecycleDiagnostics).toMatchObject({
      actionableState: "recovery-requires-manual-attention",
      ownedResources: { maintenanceOperations: 1 },
      providerMaintenance: expect.arrayContaining([{ providerId, state: "quarantined" }]),
    });
    expect(detect.mock.calls.some(([id]) => id === providerId)).toBe(false);
  } finally {
    client.socket.close();
  }
  await runtime.close();
  expect(paths.journal.pending()).toEqual([expect.objectContaining({ runtimeCleanupConfirmed: false })]);
});

it.each(PROVIDER_IDS)("reopens %s only after native verification and durable retirement", async (providerId) => {
  const paths = profile(await nativeIdentity(providerId));
  mockProviderDiscovery();
  const runtime = await startRuntime({
    ...paths, confirmedTerminatedRuntimeGenerationIds: [paths.priorGeneration],
  });
  cleanup.runtimes.push(runtime);
  expect(paths.journal.pending()).toEqual([]);
  const client = await connectRuntime(runtime.websocketUrl);
  try {
    await runtime.startPostReadyWork();
    const refreshed = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated" && event.snapshot.providers.some(({ id, canRun }) => id === providerId && canRun));
    expect(refreshed.snapshot.providers.find(({ id }) => id === providerId)?.installState).toBe("installed");
    expect(refreshed.snapshot.lifecycleDiagnostics?.startupBlockerCodes).toEqual([]);
  } finally {
    client.socket.close();
  }
});

it.each(PROVIDER_IDS.filter((id) => id !== "antigravity").flatMap((providerId) =>
  [true, false].map((protocolVerified) => [providerId, protocolVerified] as const),
))("separates %s sign-in from recovery (protocol verified: %s)", async (providerId, protocolVerified) => {
  const paths = profile(await nativeIdentity(providerId));
  mockProviderDiscovery(providerId, { authState: "unauthenticated", canRun: false, protocolVerified, statusMessage: "Sign in required" });
  const runtime = await startRuntime({
    ...paths, confirmedTerminatedRuntimeGenerationIds: [paths.priorGeneration],
  });
  cleanup.runtimes.push(runtime);
  expect(paths.journal.pending()).toHaveLength(protocolVerified ? 0 : 1);
  const client = await connectRuntime(runtime.websocketUrl);
  try {
    await runtime.startPostReadyWork();
    const refreshed = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated" && event.snapshot.providers.some(({ id, canRun }) => id !== providerId && canRun));
    expect(refreshed.snapshot.providers.find(({ id }) => id === providerId)).toMatchObject(protocolVerified
      ? { installState: "installed", authState: "unauthenticated", canRun: false, statusMessage: "Sign in required" }
      : { installState: "recovery-required", canRun: false });
    expect(vi.mocked(ProviderManager.prototype.metadata).mock.calls.some(([id]) => id === providerId)).toBe(false);
  } finally {
    client.socket.close();
  }
});

it.each([
  ["claude", "authenticated"],
  ["codex", "authenticated"],
  ["claude", "error"],
  ["kimi", "unknown"],
] as const)("keeps %s recovery pending when an installation with %s authentication cannot run", async (providerId, authState) => {
  const paths = profile(await nativeIdentity(providerId));
  mockProviderDiscovery(providerId, {
    authState, canRun: false, protocolVerified: true,
    statusMessage: "Claude Code launch target is missing",
  });
  const runtime = await startRuntime({
    ...paths, confirmedTerminatedRuntimeGenerationIds: [paths.priorGeneration],
  });
  cleanup.runtimes.push(runtime);
  expect(paths.journal.pending()).toHaveLength(1);
  const client = await connectRuntime(runtime.websocketUrl);
  try {
    await runtime.startPostReadyWork();
    const refreshed = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated" && event.snapshot.providers.some(({ id, canRun }) => id !== providerId && canRun));
    expect(refreshed.snapshot.providers.find(({ id }) => id === providerId)).toMatchObject({
      installState: "recovery-required", canRun: false,
    });
    expect(vi.mocked(ProviderManager.prototype.metadata).mock.calls.some(([id]) => id === providerId)).toBe(false);
  } finally {
    client.socket.close();
  }
});

it.each((["kimi", "antigravity"] as const).flatMap((providerId) =>
  [true, false].map((protocolVerified) => [providerId, protocolVerified] as const),
))("preserves %s session-time authentication (protocol verified: %s)", async (providerId, protocolVerified) => {
  const paths = profile(await nativeIdentity(providerId));
  mockProviderDiscovery(providerId, {
    authState: "unknown", canRun: true,
    // Antigravity has no static auth probe and uses canRun as its protocol evidence.
    protocolVerified: protocolVerified && providerId === "antigravity" ? undefined : protocolVerified,
  });
  const runtime = await startRuntime({
    ...paths, confirmedTerminatedRuntimeGenerationIds: [paths.priorGeneration],
  });
  cleanup.runtimes.push(runtime);
  expect(paths.journal.pending()).toHaveLength(protocolVerified ? 0 : 1);
  const client = await connectRuntime(runtime.websocketUrl);
  try {
    await runtime.startPostReadyWork();
    const refreshed = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated" && event.snapshot.providers.some(({ id, canRun }) => id !== providerId && canRun));
    expect(refreshed.snapshot.providers.find(({ id }) => id === providerId)).toMatchObject(protocolVerified
      ? { installState: "installed", authState: "unknown", canRun: true }
      : { installState: "recovery-required", canRun: false });
    expect(vi.mocked(ProviderManager.prototype.metadata).mock.calls.some(([id]) => id === providerId)).toBe(protocolVerified);
  } finally {
    client.socket.close();
  }
});

it("retires one provider while another simultaneous recovery remains quarantined", async () => {
  const paths = profile(await nativeIdentity("codex"));
  expect(paths.journal.begin("interrupted-claude-update", await nativeIdentity("claude"))).toBe(true);
  mockProviderDiscovery("claude", { authState: "unauthenticated", canRun: false, protocolVerified: false });
  const runtime = await startRuntime({
    ...paths, confirmedTerminatedRuntimeGenerationIds: [paths.priorGeneration],
  });
  cleanup.runtimes.push(runtime);
  expect(paths.journal.pending()).toEqual([expect.objectContaining({
    installationIdentity: expect.objectContaining({ providerId: "claude" }), runtimeCleanupConfirmed: true,
  })]);
  const client = await connectRuntime(runtime.websocketUrl);
  try {
    await runtime.startPostReadyWork();
    const refreshed = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated" && event.snapshot.providers.filter(({ id }) => id !== "claude").every(({ canRun }) => canRun));
    expect(refreshed.snapshot.providers.find(({ id }) => id === "claude")?.installState).toBe("recovery-required");
    expect(refreshed.snapshot.lifecycleDiagnostics).toMatchObject({
      ownedResources: { maintenanceOperations: 1 },
      providerMaintenance: expect.arrayContaining([{ providerId: "claude", state: "quarantined" }]),
    });
  } finally {
    client.socket.close();
  }
  await runtime.close();
});

it("persists maintenance cleanup before acknowledging and deleting the supervisor receipt", async () => {
  const paths = profile();
  const receipts = new RuntimeCleanupReceiptJournal(paths.dataDirectory);
  expect(receipts.publish(paths.priorGeneration)).toBe(true);
  const acknowledge = vi.fn((generationId: string) => {
    expect(paths.journal.pending()[0]?.runtimeCleanupConfirmed).toBe(true);
    expect(receipts.consume(generationId)).toBe(true);
  });
  const runtime = await startRuntime({
    ...paths, enableProviders: false,
    confirmedTerminatedRuntimeGenerationIds: [paths.priorGeneration],
    onCleanupReceiptConsumed: acknowledge,
  });
  cleanup.runtimes.push(runtime);
  expect(acknowledge).toHaveBeenCalledWith(paths.priorGeneration, paths.runtimeGenerationId);
  expect(new RuntimeCleanupReceiptJournal(paths.dataDirectory).pending()).toEqual([]);
  await runtime.close();
  expect(new ProviderMaintenanceJournal(paths.dataDirectory, {
    runtimeGenerationId: `${randomUUID()}:1`, systemBootId: paths.systemBootId,
  }).pending()[0]?.runtimeCleanupConfirmed).toBe(true);
});

it("retains the supervisor receipt and closes persistence if the cleanup checkpoint fails", async () => {
  const paths = profile();
  const receipts = new RuntimeCleanupReceiptJournal(paths.dataDirectory);
  expect(receipts.publish(paths.priorGeneration)).toBe(true);
  const acknowledge = vi.fn();
  const closeStore = vi.spyOn(RuntimeStore.prototype, "backupAndClose");
  vi.spyOn(ProviderMaintenanceJournal.prototype, "reconcile").mockImplementationOnce(() => {
    throw new Error("injected checkpoint storage failure");
  });
  await expect(startRuntime({
    ...paths, enableProviders: false,
    confirmedTerminatedRuntimeGenerationIds: [paths.priorGeneration],
    onCleanupReceiptConsumed: acknowledge,
  })).rejects.toThrow("cleanup proof could not be preserved");
  expect(acknowledge).not.toHaveBeenCalled();
  expect(closeStore).toHaveBeenCalledOnce();
  expect(new RuntimeCleanupReceiptJournal(paths.dataDirectory).pending()).toEqual([paths.priorGeneration]);
});
