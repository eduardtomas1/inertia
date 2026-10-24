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
import { ProviderManager, PROVIDER_INFO } from "../../src/server/providers";
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

function profile(installationIdentity?: ProviderInstallationIdentity) {
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
  expect(journal.begin("interrupted-claude-update", installationIdentity ?? providerInstallationIdentity({
    providerId: "claude", executable: null, installationRootIdentity: "fixture-claude",
    packageIdentity: null, version: "1.0.0",
  }))).toBe(true);
  expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(runtimeGenerationId, systemBootId)).toBe(true);
  return { dataDirectory, defaultWorkspacePath, runtimeGenerationId, systemBootId, priorGeneration, journal };
}

function mockProviderDiscovery(claudeNeedsSignIn = false, claudeProtocolVerified = true) {
  const originalFactory = ProviderManager.createProduction;
  const detect = vi.fn(async (id: keyof typeof PROVIDER_INFO) => ({
    provider: PROVIDER_INFO[id], available: true, version: "1.0.0",
    executable: process.execPath, installState: "installed" as const,
    authState: id === "claude" && claudeNeedsSignIn ? "unauthenticated" as const : "authenticated" as const,
    canRun: id !== "claude" || !claudeNeedsSignIn,
    statusMessage: id === "claude" && claudeNeedsSignIn ? "Sign in required" : "Connected",
    protocolVerified: id !== "claude" || claudeProtocolVerified, cleanupConfirmed: true,
  }));
  vi.spyOn(ProviderManager, "createProduction").mockImplementation((options, registry) =>
    originalFactory({ ...options, detectProvider: detect }, registry));
  vi.spyOn(ProviderManager.prototype, "metadata").mockImplementation(async function (this: ProviderManager, id) {
    return this.cachedMetadata(id);
  });
  vi.spyOn(ProviderMaintenanceController.prototype, "refresh").mockResolvedValue([]);
  return detect;
}

it("keeps unrelated providers usable and shuts down cleanly with orphaned maintenance", async () => {
  const paths = profile();
  const detect = mockProviderDiscovery();
  const runtime = await startRuntime(paths);
  cleanup.runtimes.push(runtime);
  const client = await connectRuntime(runtime.websocketUrl);
  try {
    const welcome = await client.events.next((event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome");
    expect(welcome.snapshot.providers.find(({ id }) => id === "claude")).toMatchObject({
      installState: "recovery-required", authState: "unknown", canRun: false,
    });
    await runtime.startPostReadyWork();
    const refreshed = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated"
      && event.snapshot.providers.some(({ id, canRun }) => id === "codex" && canRun));
    expect(refreshed.snapshot.providers.find(({ id }) => id === "codex")).toMatchObject({
      installState: "installed", authState: "authenticated", canRun: true,
    });
    expect(refreshed.snapshot.providers.find(({ id }) => id === "claude")?.installState).toBe("recovery-required");
    expect(refreshed.snapshot.lifecycleDiagnostics).toMatchObject({
      actionableState: "recovery-requires-manual-attention",
      ownedResources: { maintenanceOperations: 1 },
      providerMaintenance: expect.arrayContaining([{ providerId: "claude", state: "quarantined" }]),
    });
    expect(detect.mock.calls.some(([id]) => id === "claude")).toBe(false);
  } finally {
    client.socket.close();
  }
  await runtime.close();
  expect(paths.journal.pending()).toEqual([expect.objectContaining({ runtimeCleanupConfirmed: false })]);
});

it("reopens the recovered provider only after native verification and durable retirement", async () => {
  const seedManager = ProviderManager.createProduction({
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    conversationProviderGate: () => undefined,
  });
  const identity = seedManager.providerInstallationIdentityForMaintenance("claude", process.execPath, "1.0.0");
  await seedManager.disposeAll();
  const paths = profile(identity);
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
      event.type === "snapshot.updated" && event.snapshot.providers.some(({ id, canRun }) => id === "claude" && canRun));
    expect(refreshed.snapshot.providers.find(({ id }) => id === "claude")?.installState).toBe("installed");
    expect(refreshed.snapshot.lifecycleDiagnostics?.startupBlockerCodes).toEqual([]);
  } finally {
    client.socket.close();
  }
});

it.each([true, false])("keeps sign-in separate from installation recovery (protocol verified: %s)", async (protocolVerified) => {
  const seedManager = ProviderManager.createProduction({
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    conversationProviderGate: () => undefined,
  });
  const identity = seedManager.providerInstallationIdentityForMaintenance("claude", process.execPath, "1.0.0");
  await seedManager.disposeAll();
  const paths = profile(identity);
  mockProviderDiscovery(true, protocolVerified);
  const runtime = await startRuntime({
    ...paths, confirmedTerminatedRuntimeGenerationIds: [paths.priorGeneration],
  });
  cleanup.runtimes.push(runtime);
  expect(paths.journal.pending()).toHaveLength(protocolVerified ? 0 : 1);
  const client = await connectRuntime(runtime.websocketUrl);
  try {
    await runtime.startPostReadyWork();
    const refreshed = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated" && event.snapshot.providers.some(({ id, canRun }) => id === "codex" && canRun));
    expect(refreshed.snapshot.providers.find(({ id }) => id === "claude")).toMatchObject(protocolVerified
      ? { installState: "installed", authState: "unauthenticated", canRun: false, statusMessage: "Sign in required" }
      : { installState: "recovery-required", canRun: false });
    expect(vi.mocked(ProviderManager.prototype.metadata).mock.calls.some(([id]) => id === "claude")).toBe(false);
  } finally {
    client.socket.close();
  }
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
