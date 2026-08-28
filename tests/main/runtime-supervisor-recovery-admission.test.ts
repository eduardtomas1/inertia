import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { LegacyRuntimeRecoveryAuthorityJournal } from
  "../../src/main/runtime-legacy-recovery-authorities";
import {
  captureModernDarwinRecoverySnapshot,
  ModernDarwinRecoveryAuthorityJournal,
  type ModernDarwinRecoveryAuthorityDescriptor,
} from "../../src/node/runtime-modern-recovery-authorities";
import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from
  "../../src/node/runtime-owned-processes";
import type { RuntimeWorkerCommand } from
  "../../src/node/runtime-process-protocol";

const firstUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const workspaceDirectory = resolve(tmpdir(), "inertia workspace");
let dataDirectory: string;

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined;
  readonly messages: RuntimeWorkerCommand[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  postMessage(message: RuntimeWorkerCommand): void {
    this.messages.push(message);
  }

  kill(): boolean {
    return true;
  }

  spawn(): void { this.emit("spawn"); }
  message(value: unknown): void {
    if (
      value
      && typeof value === "object"
      && "type" in value
      && value.type === "runtime.ready"
    ) {
      const start = this.messages.findLast((message) =>
        message.type === "runtime.start");
      if (start?.type === "runtime.start") {
        for (const retiredRuntimeGenerationId of
          start.options.manuallyRetiredRuntimeGenerationIds ?? []) {
          this.emit("message", {
            type: "runtime.legacy-recovery-authority-consumed",
            retiredRuntimeGenerationId,
            currentRuntimeGenerationId: start.options.runtimeGenerationId,
          });
        }
        if (start.options.manualModernDarwinRecovery) {
          this.emit("message", {
            type: "runtime.modern-darwin-recovery-authority-acknowledged",
            operationId: start.options.manualModernDarwinRecovery.operationId,
            snapshotDigest:
              start.options.manualModernDarwinRecovery.snapshotDigest,
            currentRuntimeGenerationId:
              start.options.runtimeGenerationId,
          });
        }
      }
    }
    this.emit("message", value);
  }
}

function createHarness(options: {
  systemBootId?: string;
  recoverOwnedProcesses?: () => boolean;
  manualModernDarwinRecovery?: ModernDarwinRecoveryAuthorityDescriptor;
  runtimeProcessGuardianPath?: string;
  runtimeRecoveryBlocked?: boolean;
} = {}) {
  const children: FakeUtilityProcess[] = [];
  const supervisor = new RuntimeSupervisor({
    systemBootId: options.systemBootId
      ?? "test:00000000-0000-4000-8000-000000000001",
    ...(options.runtimeRecoveryBlocked
      ? { runtimeRecoveryBlocked: true }
      : {}),
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: workspaceDirectory,
      enableProviders: false,
      ...(options.manualModernDarwinRecovery
        ? { manualModernDarwinRecovery: options.manualModernDarwinRecovery }
        : {}),
      ...(options.runtimeProcessGuardianPath
        ? { runtimeProcessGuardianPath: options.runtimeProcessGuardianPath }
        : {}),
    },
    spawn: () => {
      const child = new FakeUtilityProcess(10_000 + children.length);
      children.push(child);
      return child as never;
    },
    startupTimeoutMs: 2_000,
    stableUptimeMs: 5_000,
    shutdownGraceMs: 1_000,
    forceKillWaitMs: 500,
    forceKill: () => true,
    recoverOwnedProcesses: options.recoverOwnedProcesses ?? (() => true),
    armProcessContainment: () => process.platform === "win32"
      ? {
          kind: "windows-job-v1",
          name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
        }
      : null,
  });
  return { children, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-supervisor-recovery-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("RuntimeSupervisor recovery admission", () => {
  const currentAuthorityPlatform = (): "darwin" | "linux" | "win32" => {
    if (process.platform === "darwin" || process.platform === "win32") {
      return process.platform;
    }
    return "linux";
  };
  it("does not recover or spawn after manual runtime recovery is declined", async () => {
    const recoverOwnedProcesses = vi.fn(() => true);
    const { children, supervisor } = createHarness({
      runtimeRecoveryBlocked: true,
      recoverOwnedProcesses,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(children).toEqual([]);
    expect(recoverOwnedProcesses).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      lastError: expect.stringMatching(/explicit confirmation/u),
    });
  });

  it("retires a recoverable prior app generation before spawning", async () => {
    const priorGeneration = "30000000-0000-4000-8000-000000000003:7";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    expect(new RuntimeGenerationLeaseJournal(dataDirectory)
      .publish(priorGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory)
      .startSession(priorGeneration, bootId)).toBe(true);
    const { children, supervisor } = createHarness();

    supervisor.start();
    expect(children).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(children).toHaveLength(1);
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        confirmedTerminatedRuntimeGenerationIds: [priorGeneration],
      },
    });
  });

  it("passes and consumes only a current-boot manual legacy authority", () => {
    const legacyGenerationId =
      "30000000-0000-4000-8000-000000000003:70";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      legacyGenerationId,
      "unavailable",
    )).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory).publish(
      legacyGenerationId,
      platform,
      bootId,
    )).toBe(true);
    const { children, supervisor } = createHarness();

    supervisor.start();
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        manuallyRetiredRuntimeGenerationIds: [legacyGenerationId],
      },
    });
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([]);
  });

  it("resumes legacy authority retirement after its lease was already removed", () => {
    const legacyGenerationId =
      "30000000-0000-4000-8000-000000000003:701";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(legacyGenerationId, "unavailable")).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory).publish(
      legacyGenerationId,
      platform,
      bootId,
    )).toBe(true);

    // This is the durable state left when the utility runtime crashes after
    // clearing the lease but before the supervisor consumes the authority.
    expect(leases.clearUnavailableRuntimeGeneration(legacyGenerationId))
      .toBe(true);
    const { children, supervisor } = createHarness();

    supervisor.start();
    expect(children).toHaveLength(1);
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        manuallyRetiredRuntimeGenerationIds: [legacyGenerationId],
      },
    });
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([]);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([
      expect.objectContaining({
        runtimeGenerationId: expect.not.stringMatching(legacyGenerationId),
      }),
    ]);
  });

  it("retains a complete legacy authority batch until its final acknowledgement", () => {
    const legacyGenerationIds = [
      "30000000-0000-4000-8000-000000000003:702",
      "30000000-0000-4000-8000-000000000003:703",
    ];
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    for (const generationId of legacyGenerationIds) {
      expect(leases.publish(generationId, "unavailable")).toBe(true);
    }
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch(legacyGenerationIds, platform, bootId)).toBe(true);
    const { children, supervisor } = createHarness();

    supervisor.start();
    children[0].spawn();
    expect(leases.clearUnavailableRuntimeGeneration(legacyGenerationIds[0]!))
      .toBe(true);
    children[0].message({
      type: "runtime.legacy-recovery-authority-consumed",
      retiredRuntimeGenerationId: legacyGenerationIds[0],
      currentRuntimeGenerationId: children[0].messages.findLast((message) =>
        message.type === "runtime.start")!.options.runtimeGenerationId,
    });

    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual(legacyGenerationIds);
    expect(leases.clearUnavailableRuntimeGeneration(legacyGenerationIds[1]!))
      .toBe(true);
    children[0].message({
      type: "runtime.legacy-recovery-authority-consumed",
      retiredRuntimeGenerationId: legacyGenerationIds[1],
      currentRuntimeGenerationId: children[0].messages.findLast((message) =>
        message.type === "runtime.start")!.options.runtimeGenerationId,
    });

    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([]);
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
  });

  it("retires exact modern Darwin state only after the runtime DB acknowledgement", () => {
    const oldGenerationId =
      "30000000-0000-4000-8000-000000000003:75";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(oldGenerationId, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(oldGenerationId, bootId)).toBe(true);
    const snapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      bootId,
    );
    expect(snapshot).not.toBeNull();
    const descriptor = snapshot
      ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
        .publish(snapshot)
      : null;
    expect(descriptor).not.toBeNull();
    const { children, supervisor } = createHarness({
      systemBootId: bootId,
      manualModernDarwinRecovery: descriptor!,
      runtimeProcessGuardianPath: "/private/tmp/inertia-test-guardian",
    });

    supervisor.start();
    expect(children).toHaveLength(1);
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        manualModernDarwinRecovery: descriptor,
      },
    });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toHaveLength(2);
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
      .toBeNull();
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([
      expect.objectContaining({
        runtimeGenerationId: expect.not.stringMatching(oldGenerationId),
      }),
    ]);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).records(oldGenerationId)).toBeNull();
  });

  it("retires probe-unavailable modern Darwin state only after DB acknowledgement", () => {
    const oldGenerationId =
      "30000000-0000-4000-8000-000000000003:80";
    const legacyGenerationId =
      "30000000-0000-4000-8000-000000000003:81";
    const platform = currentAuthorityPlatform();
    const recordedModernBootId =
      "test:00000000-0000-4000-8000-000000000009";
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(oldGenerationId, recordedModernBootId)).toBe(true);
    expect(leases.publish(legacyGenerationId, "unavailable")).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(oldGenerationId, recordedModernBootId)).toBe(true);
    const snapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      "unavailable",
    );
    const descriptor = snapshot
      ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
        .publish(snapshot)
      : null;
    expect(descriptor).not.toBeNull();
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch(
        [legacyGenerationId],
        platform,
        "unavailable",
      )).toBe(true);
    const { children, supervisor } = createHarness({
      systemBootId: "unavailable",
      manualModernDarwinRecovery: descriptor!,
      runtimeProcessGuardianPath: "/private/tmp/inertia-test-guardian",
    });

    supervisor.start();
    expect(children).toHaveLength(1);
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        manuallyRetiredRuntimeGenerationIds: [legacyGenerationId],
        manualModernDarwinRecovery: descriptor,
      },
    });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
      .toHaveLength(3);
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
      .toBeNull();
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, "unavailable")).toEqual([]);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
      .not.toContainEqual(expect.objectContaining({
        runtimeGenerationId: oldGenerationId,
      }));
  });

  it("consumes a mixed legacy and modern recovery batch before readiness", () => {
    const modernGenerationId =
      "30000000-0000-4000-8000-000000000003:78";
    const legacyGenerationId =
      "30000000-0000-4000-8000-000000000003:79";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(modernGenerationId, bootId)).toBe(true);
    expect(leases.publish(legacyGenerationId, "unavailable")).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(modernGenerationId, bootId)).toBe(true);
    const snapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      bootId,
    );
    expect(snapshot).not.toBeNull();
    const modernDescriptor = snapshot
      ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
        .publish(snapshot)
      : null;
    expect(modernDescriptor).not.toBeNull();
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch([legacyGenerationId], platform, bootId)).toBe(true);
    const { children, supervisor } = createHarness({
      systemBootId: bootId,
      manualModernDarwinRecovery: modernDescriptor!,
      runtimeProcessGuardianPath: "/private/tmp/inertia-test-guardian",
    });

    supervisor.start();
    expect(children).toHaveLength(1);
    children[0].spawn();
    const start = children[0].messages.at(-1);
    expect(start).toMatchObject({
      type: "runtime.start",
      options: {
        manuallyRetiredRuntimeGenerationIds: [legacyGenerationId],
        manualModernDarwinRecovery: modernDescriptor,
      },
    });
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([]);
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
      .toBeNull();
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
      .not.toContainEqual(expect.objectContaining({
        runtimeGenerationId: modernGenerationId,
      }));
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).records(modernGenerationId)).toBeNull();
  });

  it("reserves one current lease slot for the maximum legacy recovery batch", () => {
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    const legacyGenerationIds = Array.from({ length: 32 }, (_, index) => (
      `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}:1`
    ));
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    for (const generationId of legacyGenerationIds) {
      expect(leases.publish(generationId, "unavailable")).toBe(true);
    }
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch(legacyGenerationIds, platform, bootId)).toBe(true);
    const { children, supervisor } = createHarness();

    supervisor.start();
    expect(children).toHaveLength(1);
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        manuallyRetiredRuntimeGenerationIds: legacyGenerationIds,
      },
    });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
      .toHaveLength(33);
  });

  it("withholds a partial legacy authority batch until every lease is authorized", () => {
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    const legacyGenerationIds = [
      "30000000-0000-4000-8000-000000000003:73",
      "30000000-0000-4000-8000-000000000003:74",
    ];
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    for (const generationId of legacyGenerationIds) {
      expect(leases.publish(generationId, "unavailable")).toBe(true);
    }
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory).publish(
      legacyGenerationIds[0]!,
      platform,
      bootId,
    )).toBe(true);
    const { children, supervisor } = createHarness();

    supervisor.start();
    expect(children).toHaveLength(0);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      lastError:
        "The manual legacy runtime recovery authority changed before startup.",
    });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([legacyGenerationIds[0]]);
  });

  it("replays a complete legacy batch when one exact lease was already retired", () => {
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    const legacyGenerationIds = [
      "30000000-0000-4000-8000-000000000003:76",
      "30000000-0000-4000-8000-000000000003:77",
    ];
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    for (const generationId of legacyGenerationIds) {
      expect(leases.publish(generationId, "unavailable")).toBe(true);
    }
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch(legacyGenerationIds, platform, bootId)).toBe(true);
    expect(leases.clearRuntimeGeneration(legacyGenerationIds[1]!)).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .retireExpired(
        platform,
        bootId,
      )).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual(legacyGenerationIds);
    const { children, supervisor } = createHarness();

    supervisor.start();
    expect(children).toHaveLength(1);
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        manuallyRetiredRuntimeGenerationIds: legacyGenerationIds,
      },
    });
    expect(leases.clearUnavailableRuntimeGeneration(legacyGenerationIds[0]!))
      .toBe(true);
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([]);
  });

  it("replays a complete legacy batch after every lease was acknowledged", () => {
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    const legacyGenerationIds = [
      "30000000-0000-4000-8000-000000000003:84",
      "30000000-0000-4000-8000-000000000003:85",
    ];
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    for (const generationId of legacyGenerationIds) {
      expect(leases.publish(generationId, "unavailable")).toBe(true);
    }
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch(legacyGenerationIds, platform, bootId)).toBe(true);
    for (const generationId of legacyGenerationIds) {
      expect(leases.clearRuntimeGeneration(generationId)).toBe(true);
    }
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .retireExpired(platform, bootId)).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual(legacyGenerationIds);
    const { children, supervisor } = createHarness();

    supervisor.start();
    expect(children).toHaveLength(1);
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        manuallyRetiredRuntimeGenerationIds: legacyGenerationIds,
      },
    });
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([]);
  });

  it("replays a singleton legacy authority after its lease was acknowledged", () => {
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const platform = currentAuthorityPlatform();
    const legacyGenerationId =
      "30000000-0000-4000-8000-000000000003:86";
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(legacyGenerationId, "unavailable")).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch([legacyGenerationId], platform, bootId)).toBe(true);
    expect(leases.clearRuntimeGeneration(legacyGenerationId)).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .retireExpired(platform, bootId)).toBe(true);
    const { children, supervisor } = createHarness();

    supervisor.start();
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        manuallyRetiredRuntimeGenerationIds: [legacyGenerationId],
      },
    });
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([]);
  });

  it("never admits a manual legacy authority from another boot", () => {
    const legacyGenerationId =
      "30000000-0000-4000-8000-000000000003:71";
    const platform = currentAuthorityPlatform();
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory).publish(
      legacyGenerationId,
      platform,
      "test:10000000-0000-4000-8000-000000000001",
    )).toBe(true);
    const { children, supervisor } = createHarness();

    supervisor.start();
    children[0].spawn();
    expect(children[0].messages.at(-1)).not.toMatchObject({
      options: {
        manuallyRetiredRuntimeGenerationIds: expect.anything(),
      },
    });
  });

  it("admits exact manual legacy recovery when the boot probe is unavailable", () => {
    const legacyGenerationId =
      "30000000-0000-4000-8000-000000000003:72";
    const platform = currentAuthorityPlatform();
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      legacyGenerationId,
      "unavailable",
    )).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch([legacyGenerationId], platform, "unavailable")).toBe(true);
    const { children, supervisor } = createHarness({
      systemBootId: "unavailable",
    });

    supervisor.start();
    children[0].spawn();
    expect(children[0].messages.at(-1)).toMatchObject({
      options: {
        manuallyRetiredRuntimeGenerationIds: [legacyGenerationId],
      },
    });
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, "unavailable")).toEqual([]);
  });

});
