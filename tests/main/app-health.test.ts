import { describe, expect, it, vi } from "vitest";

import {
  AppHealthCollector,
  InertiaHealthRegistry,
  type HealthRenderer,
  type HealthSession,
} from "../../src/main/app-health";

function session(cacheBytes: number): HealthSession & {
  clearCache: ReturnType<typeof vi.fn<() => Promise<void>>>;
  getCacheSize: ReturnType<typeof vi.fn<() => Promise<number>>>;
} {
  return {
    clearCache: vi.fn(async () => undefined),
    getCacheSize: vi.fn(async () => cacheBytes),
  };
}

function renderer(pid: number, ownedSession: HealthSession): HealthRenderer {
  return {
    session: ownedSession,
    getOSProcessId: () => pid,
    isDestroyed: () => false,
  };
}

function metric(pid: number, memoryKb: number) {
  return {
    pid,
    cpu: { percentCPUUsage: pid / 10 },
    memory: { workingSetSize: memoryKb },
  };
}

describe("app health collection", () => {
  it("measures and clears only registered Inertia resources", async () => {
    const registry = new InertiaHealthRegistry();
    const mainSession = session(1_024);
    const detachedSession = session(2_048);
    const unrelatedSession = session(8_192);
    registry.registerProcess("main", () => 10);
    registry.registerProcess("runtime", () => 30);
    registry.registerRenderer(renderer(20, mainSession));
    registry.registerRenderer(renderer(21, detachedSession));
    const collector = new AppHealthCollector({
      registry,
      getProcessMetrics: () => [
        metric(10, 10),
        metric(20, 20),
        metric(21, 21),
        metric(30, 30),
        metric(999, 1_000),
      ],
      getRuntimePhase: () => "ready",
      readDatabaseBytes: async () => 4_096,
      readTemporaryAttachmentBytes: () => 512,
      now: () => new Date("2030-01-02T03:04:05.000Z"),
    });

    await expect(collector.collect()).resolves.toMatchObject({
      sampledAt: "2030-01-02T03:04:05.000Z",
      totalMemoryBytes: 81 * 1_024,
      mainProcess: { pid: 10, memoryBytes: 10 * 1_024 },
      rendererProcesses: [
        { pid: 20, memoryBytes: 20 * 1_024 },
        { pid: 21, memoryBytes: 21 * 1_024 },
      ],
      runtimeProcess: { pid: 30, memoryBytes: 30 * 1_024 },
      cacheBytes: 3_072,
      warnings: [],
    });
    await expect(collector.clearCache()).resolves.toMatchObject({
      cacheBytes: 3_072,
      warnings: [],
    });
    expect(mainSession.clearCache).toHaveBeenCalledOnce();
    expect(detachedSession.clearCache).toHaveBeenCalledOnce();
    expect(unrelatedSession.clearCache).not.toHaveBeenCalled();
  });

  it("keeps independent measurements when cache and storage sources fail", async () => {
    const registry = new InertiaHealthRegistry();
    const failedSession = session(0);
    failedSession.getCacheSize.mockRejectedValue(new Error("private cache error"));
    registry.registerProcess("main", () => 10);
    registry.registerRenderer(renderer(20, failedSession));
    const collector = new AppHealthCollector({
      registry,
      getProcessMetrics: () => [metric(10, 10), metric(20, 20)],
      getRuntimePhase: () => "ready",
      readDatabaseBytes: async () => {
        throw new Error("private database path");
      },
      readTemporaryAttachmentBytes: () => {
        throw new Error("private attachment state");
      },
    });

    const health = await collector.collect();
    expect(health).toMatchObject({
      totalMemoryBytes: 30 * 1_024,
      mainProcess: { pid: 10 },
      rendererProcesses: [{ pid: 20 }],
      runtimePhase: "ready",
      databaseBytes: null,
      cacheBytes: null,
      temporaryAttachmentBytes: null,
    });
    expect(health.warnings).toEqual([
      { code: "database", message: "Database storage could not be measured." },
      { code: "cache", message: "Browser cache storage could not be measured." },
      { code: "attachments", message: "Temporary attachment storage could not be measured." },
    ]);
    expect(health.warnings).toHaveLength(3);
  });

  it("reports a partial clear without hiding otherwise healthy metrics", async () => {
    const registry = new InertiaHealthRegistry();
    const healthy = session(100);
    const failed = session(200);
    failed.clearCache.mockRejectedValue(new Error("private clear error"));
    registry.registerProcess("main", () => 10);
    registry.registerRenderer(renderer(20, healthy));
    registry.registerRenderer(renderer(21, failed));
    const collector = new AppHealthCollector({
      registry,
      getProcessMetrics: () => [
        metric(10, 10),
        metric(20, 20),
        metric(21, 21),
      ],
      getRuntimePhase: () => "idle",
      readDatabaseBytes: async () => 300,
      readTemporaryAttachmentBytes: () => 400,
    });

    await expect(collector.clearCache()).resolves.toMatchObject({
      totalMemoryBytes: 51 * 1_024,
      databaseBytes: 300,
      cacheBytes: 300,
      temporaryAttachmentBytes: 400,
      warnings: [{
        code: "cache-clear",
        message: "Some Inertia browser caches could not be cleared.",
      }],
    });
    expect(healthy.clearCache).toHaveBeenCalledOnce();
    expect(failed.clearCache).toHaveBeenCalledOnce();
  });
});
