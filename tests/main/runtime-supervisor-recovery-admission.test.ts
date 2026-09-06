import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeSupervisor,
  type RuntimeAttachmentBroker,
} from "../../src/main/runtime-supervisor";
import { RuntimeCleanupReceiptJournal } from
  "../../src/main/runtime-cleanup-receipts";
import { prepareModernDarwinBootstrapRecovery } from
  "../../src/main/runtime-bootstrap-safety";
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
const attachmentId = "33333333-3333-4333-8333-333333333333";
const attachmentHandoffId = "44444444-4444-4444-8444-444444444444";
const trustedAttachment = {
  id: attachmentId,
  name: "recovery.png",
  path: resolve(tmpdir(), "inertia attachments", `${attachmentId}.png`),
  mimeType: "image/png" as const,
  size: 8,
  digest: "a".repeat(64),
};
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
  attachmentBroker?: RuntimeAttachmentBroker;
  manualModernDarwinRecovery?: ModernDarwinRecoveryAuthorityDescriptor;
  runtimeProcessGuardianPath?: string;
  runtimeRecoveryBlocked?: boolean;
} = {}) {
  const children: FakeUtilityProcess[] = [];
  const forceKill = vi.fn(() => true);
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
    forceKill,
    recoverOwnedProcesses: options.recoverOwnedProcesses ?? (() => true),
    attachmentBroker: options.attachmentBroker,
    armProcessContainment: () => process.platform === "win32"
      ? {
          kind: "windows-job-v1",
          name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
        }
      : null,
  });
  return { children, forceKill, supervisor };
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

  it("retains an unleased empty session when lease publication fails", () => {
    const publish = vi.spyOn(
      RuntimeGenerationLeaseJournal.prototype,
      "publish",
    ).mockReturnValueOnce(false);
    const startSession = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "startSession",
    );
    const { children, supervisor } = createHarness();
    try {
      supervisor.start();
      const generationId = startSession.mock.calls[0]?.[0];
      expect(generationId).toEqual(expect.any(String));
      expect(children).toEqual([]);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
      expect(new RuntimeOwnedProcessJournal(dataDirectory)
        .sessionExact(generationId!)).not.toBeNull();
    } finally {
      publish.mockRestore();
      startSession.mockRestore();
    }
  });

  it("does not remove session proof when admission rollback cannot consume its lease", () => {
    const originalAll = RuntimeGenerationLeaseJournal.prototype.all;
    const all = vi.spyOn(RuntimeGenerationLeaseJournal.prototype, "all")
      .mockImplementation(function (this: RuntimeGenerationLeaseJournal) {
        const current = originalAll.call(this);
        return current.some((lease) => lease.systemBootId !== "unavailable")
          ? [...current, {
              runtimeGenerationId:
                "30000000-0000-4000-8000-000000000003:904",
              systemBootId: "unavailable",
              createdAt: new Date().toISOString(),
            }]
          : current;
      });
    const consume = vi.spyOn(
      RuntimeGenerationLeaseJournal.prototype,
      "consume",
    ).mockReturnValueOnce(false);
    const startSession = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "startSession",
    );
    const { children, supervisor } = createHarness();
    try {
      supervisor.start();
      const generationId = startSession.mock.calls[0]?.[0];
      expect(generationId).toEqual(expect.any(String));
      all.mockRestore();
      expect(children).toEqual([]);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .toEqual([expect.objectContaining({ runtimeGenerationId: generationId })]);
      expect(new RuntimeOwnedProcessJournal(dataDirectory)
        .sessionExact(generationId!)).not.toBeNull();
    } finally {
      all.mockRestore();
      consume.mockRestore();
      startSession.mockRestore();
    }
  });

  it("leaves a repairable session when admission consumes its lease first", () => {
    const originalAll = RuntimeGenerationLeaseJournal.prototype.all;
    const all = vi.spyOn(RuntimeGenerationLeaseJournal.prototype, "all")
      .mockImplementation(function (this: RuntimeGenerationLeaseJournal) {
        const current = originalAll.call(this);
        return current.some((lease) => lease.systemBootId !== "unavailable")
          ? [...current, {
              runtimeGenerationId:
                "30000000-0000-4000-8000-000000000003:905",
              systemBootId: "unavailable",
              createdAt: new Date().toISOString(),
            }]
          : current;
      });
    const finish = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "finishSession",
    ).mockReturnValueOnce(false);
    const startSession = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "startSession",
    );
    const { children, supervisor } = createHarness();
    try {
      supervisor.start();
      const generationId = startSession.mock.calls[0]?.[0];
      expect(generationId).toEqual(expect.any(String));
      all.mockRestore();
      expect(children).toEqual([]);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
      expect(new RuntimeOwnedProcessJournal(dataDirectory)
        .sessionExact(generationId!)).not.toBeNull();
    } finally {
      all.mockRestore();
      finish.mockRestore();
      startSession.mockRestore();
    }
  });

  it("extends startup once after the final exact cleanup receipt", async () => {
    const retiredGenerationId =
      "30000000-0000-4000-8000-000000000003:901";
    expect(new RuntimeCleanupReceiptJournal(dataDirectory)
      .publish(retiredGenerationId)).toBe(true);
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const start = children[0].messages.findLast((message) =>
      message.type === "runtime.start");
    if (start?.type !== "runtime.start") {
      throw new Error("Expected the recovery runtime to start.");
    }

    await vi.advanceTimersByTimeAsync(1_900);
    children[0].message({
      type: "runtime.cleanup-receipt-consumed",
      receiptRuntimeGenerationId: retiredGenerationId,
      currentRuntimeGenerationId: start.options.runtimeGenerationId,
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(forceKill).not.toHaveBeenCalled();
    expect(supervisor.snapshot().lastError).toBeNull();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
  });

  it("does not let replayed or foreign recovery receipts extend startup again", async () => {
    const retiredGenerationId =
      "30000000-0000-4000-8000-000000000003:902";
    expect(new RuntimeCleanupReceiptJournal(dataDirectory)
      .publish(retiredGenerationId)).toBe(true);
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const start = children[0].messages.findLast((message) =>
      message.type === "runtime.start");
    if (start?.type !== "runtime.start") {
      throw new Error("Expected the recovery runtime to start.");
    }

    await vi.advanceTimersByTimeAsync(1_900);
    const acknowledgement = {
      type: "runtime.cleanup-receipt-consumed" as const,
      receiptRuntimeGenerationId: retiredGenerationId,
      currentRuntimeGenerationId: start.options.runtimeGenerationId,
    };
    children[0].message(acknowledgement);
    await vi.advanceTimersByTimeAsync(1_000);
    children[0].message(acknowledgement);
    children[0].message({
      ...acknowledgement,
      receiptRuntimeGenerationId:
        "30000000-0000-4000-8000-000000000003:903",
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(forceKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(forceKill).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().lastError)
      .toBe("The runtime process did not become ready in time.");
  });

  it.runIf(process.platform === "darwin")(
    "resumes a live cleanup failure only with exact macOS authority",
    async () => {
      const bootId = "test:00000000-0000-4000-8000-000000000001";
      const recoverOwnedProcesses = vi.fn(() => false);
      const { children, supervisor } = createHarness({
        systemBootId: bootId,
        recoverOwnedProcesses,
        runtimeProcessGuardianPath: "/private/tmp/inertia-test-guardian",
      });

      supervisor.start();
      children[0].spawn();
      children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
      children[0].emit("exit", 17);
      await vi.advanceTimersByTimeAsync(0);

      expect(recoverOwnedProcesses).toHaveBeenCalledOnce();
      expect(supervisor.snapshot()).toMatchObject({ phase: "stopped" });
      expect(supervisor.canResumeWithModernDarwinRecovery()).toBe(true);
      const snapshot = captureModernDarwinRecoverySnapshot(
        dataDirectory,
        bootId,
      );
      const descriptor = snapshot
        ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
          .publish(snapshot)
        : null;
      expect(descriptor).not.toBeNull();
      expect(supervisor.resumeWithModernDarwinRecovery({
        ...descriptor!,
        operationId: "00000000-0000-4000-8000-000000000099",
      })).toBe(false);
      expect(children).toHaveLength(1);

      expect(supervisor.resumeWithModernDarwinRecovery(descriptor!)).toBe(true);
      expect(supervisor.canResumeWithModernDarwinRecovery()).toBe(false);
      expect(children).toHaveLength(2);
      children[1].spawn();
      expect(children[1].messages.at(-1)).toMatchObject({
        type: "runtime.start",
        options: { manualModernDarwinRecovery: descriptor },
      });
      children[1].message({ type: "runtime.ready", websocketUrl: firstUrl });
      expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .toBeNull();
    },
  );

  it.runIf(process.platform === "darwin")(
    "recovers a forced pre-ready replacement before reusing its recovery authority",
    async () => {
      const bootId = "test:00000000-0000-4000-8000-000000000001";
      const recoverOwnedProcesses = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const { children, supervisor } = createHarness({
        systemBootId: bootId,
        recoverOwnedProcesses,
        runtimeProcessGuardianPath: "/private/tmp/inertia-test-guardian",
      });

      supervisor.start();
      children[0].spawn();
      children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
      children[0].emit("exit", 17);
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = captureModernDarwinRecoverySnapshot(
        dataDirectory,
        bootId,
      );
      const descriptor = snapshot
        ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
          .publish(snapshot)
        : null;
      expect(descriptor).not.toBeNull();
      expect(supervisor.resumeWithModernDarwinRecovery(descriptor!)).toBe(true);

      children[1].spawn();
      const replacementStart = children[1].messages.findLast((message) =>
        message.type === "runtime.start");
      expect(replacementStart).toMatchObject({
        type: "runtime.start",
        options: { manualModernDarwinRecovery: descriptor },
      });
      if (replacementStart?.type !== "runtime.start") {
        throw new Error("Expected the manual-recovery replacement to start.");
      }
      children[1].message({
        type: "runtime.modern-darwin-recovery-authority-acknowledged",
        operationId: "00000000-0000-4000-8000-000000000099",
        snapshotDigest: descriptor!.snapshotDigest,
        currentRuntimeGenerationId:
          replacementStart.options.runtimeGenerationId,
      });
      await vi.advanceTimersByTimeAsync(0);
      children[1].emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(recoverOwnedProcesses).toHaveBeenLastCalledWith(
        replacementStart.options.runtimeGenerationId,
        bootId,
        expect.any(Number),
      );
      expect(supervisor.snapshot()).toMatchObject({
        phase: "restarting",
        restartScheduled: true,
      });
      await vi.advanceTimersByTimeAsync(500);

      expect(children).toHaveLength(3);
      children[2].spawn();
      expect(children[2].messages.at(-1)).toMatchObject({
        type: "runtime.start",
        options: { manualModernDarwinRecovery: descriptor },
      });
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .not.toBeNull();
    },
  );

  it.runIf(process.platform === "darwin")(
    "keeps an acknowledged retiring authority fail-closed until bootstrap replay",
    async () => {
      const bootId = "test:00000000-0000-4000-8000-000000000001";
      const guardianPath = "/private/tmp/inertia-test-guardian";
      const recoverOwnedProcesses = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const { children, supervisor } = createHarness({
        systemBootId: bootId,
        recoverOwnedProcesses,
        runtimeProcessGuardianPath: guardianPath,
      });

      supervisor.start();
      children[0].spawn();
      children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
      children[0].emit("exit", 17);
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = captureModernDarwinRecoverySnapshot(
        dataDirectory,
        bootId,
      );
      const authorities = new ModernDarwinRecoveryAuthorityJournal(
        dataDirectory,
      );
      const descriptor = snapshot ? authorities.publish(snapshot) : null;
      const authority = authorities.pending();
      expect(descriptor).not.toBeNull();
      expect(authority).not.toBeNull();
      expect(supervisor.resumeWithModernDarwinRecovery(descriptor!)).toBe(true);

      children[1].spawn();
      const replacementStart = children[1].messages.findLast((message) =>
        message.type === "runtime.start");
      if (replacementStart?.type !== "runtime.start") {
        throw new Error("Expected the manual-recovery replacement to start.");
      }
      const completeRetirement = vi.spyOn(
        ModernDarwinRecoveryAuthorityJournal.prototype,
        "completeRetirement",
      ).mockReturnValueOnce(false);
      try {
        children[1].message({
          type: "runtime.modern-darwin-recovery-authority-acknowledged",
          operationId: descriptor!.operationId,
          snapshotDigest: descriptor!.snapshotDigest,
          currentRuntimeGenerationId:
            replacementStart.options.runtimeGenerationId,
        });
      } finally {
        completeRetirement.mockRestore();
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .toBeNull();
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).retiring())
        .toEqual(authority);
      children[1].emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(recoverOwnedProcesses).toHaveBeenLastCalledWith(
        replacementStart.options.runtimeGenerationId,
        bootId,
        expect.any(Number),
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(children).toHaveLength(2);
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        generation: 3,
        restartScheduled: false,
        lastError: expect.stringMatching(
          /manual macOS runtime recovery authority changed/iu,
        ),
      });
      expect(supervisor.canResumeWithModernDarwinRecovery()).toBe(false);
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).retiring())
        .toEqual(authority);

      const bootstrapReplay = prepareModernDarwinBootstrapRecovery(
        dataDirectory,
        bootId,
        guardianPath,
        {
          platform: "darwin",
          readDarwinIdentity: () => null,
          pidExists: () => false,
        },
      );
      await vi.advanceTimersByTimeAsync(20);
      await expect(bootstrapReplay).resolves.toEqual({
        authority: null,
        candidate: null,
        blocked: false,
      });
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .toBeNull();
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).retiring())
        .toBeNull();
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
      expect(new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      }).records(snapshot!.generations[0]!.lease.runtimeGenerationId))
        .toBeNull();
    },
  );

  it.runIf(process.platform === "darwin")(
    "keeps post-ready attachment claims quarantined after manual recovery",
    async () => {
      const bootId = "test:00000000-0000-4000-8000-000000000001";
      const recoverOwnedProcesses = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const attachmentBroker: RuntimeAttachmentBroker = {
        resolve: vi.fn(async () => trustedAttachment),
        release: vi.fn(async () => true),
      };
      const { children, supervisor } = createHarness({
        systemBootId: bootId,
        recoverOwnedProcesses,
        attachmentBroker,
        runtimeProcessGuardianPath: "/private/tmp/inertia-test-guardian",
      });

      supervisor.start();
      children[0].spawn();
      children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
      children[0].emit("exit", 17);
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = captureModernDarwinRecoverySnapshot(
        dataDirectory,
        bootId,
      );
      const descriptor = snapshot
        ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
          .publish(snapshot)
        : null;
      expect(descriptor).not.toBeNull();
      expect(supervisor.resumeWithModernDarwinRecovery(descriptor!)).toBe(true);

      children[1].spawn();
      children[1].message({ type: "runtime.ready", websocketUrl: firstUrl });
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .toBeNull();
      children[1].message({
        type: "runtime.attachment-request",
        requestId: crypto.randomUUID(),
        attachmentId,
        handoffId: attachmentHandoffId,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

      children[1].message({ type: "invalid-runtime-message" });
      children[1].emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(recoverOwnedProcesses).toHaveBeenCalledTimes(1);
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        restartScheduled: false,
      });
      expect(supervisor.ownsAttachment(attachmentId)).toBe(true);
      expect(attachmentBroker.release).not.toHaveBeenCalled();
      expect(children).toHaveLength(2);
    },
  );

  it.runIf(process.platform === "darwin")(
    "does not replay consumed authority after a distinct pre-ready failure",
    async () => {
      const bootId = "test:00000000-0000-4000-8000-000000000001";
      const recoverOwnedProcesses = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const { children, supervisor } = createHarness({
        systemBootId: bootId,
        recoverOwnedProcesses,
        runtimeProcessGuardianPath: "/private/tmp/inertia-test-guardian",
      });

      supervisor.start();
      children[0].spawn();
      children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
      children[0].emit("exit", 17);
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = captureModernDarwinRecoverySnapshot(
        dataDirectory,
        bootId,
      );
      const descriptor = snapshot
        ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
          .publish(snapshot)
        : null;
      expect(descriptor).not.toBeNull();
      expect(supervisor.resumeWithModernDarwinRecovery(descriptor!)).toBe(true);

      children[1].spawn();
      const replacementStart = children[1].messages.findLast((message) =>
        message.type === "runtime.start");
      if (replacementStart?.type !== "runtime.start") {
        throw new Error("Expected the manual-recovery replacement to start.");
      }
      children[1].message({
        type: "runtime.modern-darwin-recovery-authority-acknowledged",
        operationId: descriptor!.operationId,
        snapshotDigest: descriptor!.snapshotDigest,
        currentRuntimeGenerationId:
          replacementStart.options.runtimeGenerationId,
      });
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .toBeNull();

      children[1].message({ type: "invalid-runtime-message" });
      children[1].emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(recoverOwnedProcesses).toHaveBeenLastCalledWith(
        replacementStart.options.runtimeGenerationId,
        bootId,
        expect.any(Number),
      );
      expect(supervisor.snapshot()).toMatchObject({
        phase: "restarting",
        restartScheduled: true,
      });
      await vi.advanceTimersByTimeAsync(500);

      expect(children).toHaveLength(3);
      children[2].spawn();
      const restarted = children[2].messages.findLast((message) =>
        message.type === "runtime.start");
      expect(restarted).toMatchObject({ type: "runtime.start" });
      if (restarted?.type !== "runtime.start") {
        throw new Error("Expected the ordinary replacement to start.");
      }
      expect(restarted.options).not.toHaveProperty(
        "manualModernDarwinRecovery",
      );
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .toBeNull();
    },
  );

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

  it("extends startup only after the final legacy authority acknowledgement", async () => {
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
    const start = children[0].messages.findLast((message) =>
      message.type === "runtime.start");
    if (start?.type !== "runtime.start") {
      throw new Error("Expected the legacy-recovery runtime to start.");
    }
    await vi.advanceTimersByTimeAsync(900);
    expect(leases.clearUnavailableRuntimeGeneration(legacyGenerationIds[0]!))
      .toBe(true);
    children[0].message({
      type: "runtime.legacy-recovery-authority-consumed",
      retiredRuntimeGenerationId: legacyGenerationIds[0],
      currentRuntimeGenerationId: start.options.runtimeGenerationId,
    });

    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual(legacyGenerationIds);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(leases.clearUnavailableRuntimeGeneration(legacyGenerationIds[1]!))
      .toBe(true);
    children[0].message({
      type: "runtime.legacy-recovery-authority-consumed",
      retiredRuntimeGenerationId: legacyGenerationIds[1],
      currentRuntimeGenerationId: start.options.runtimeGenerationId,
    });

    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending(platform, bootId)).toEqual([]);
    // The partial acknowledgement at 900 ms must not move the deadline to
    // 2,900 ms; the final exact acknowledgement at 1,900 ms owns the single
    // fresh window through 3,900 ms.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(supervisor.snapshot().lastError).toBeNull();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
  });

  it("retires exact modern Darwin state only after the runtime DB acknowledgement", async () => {
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
    const start = children[0].messages.findLast((message) =>
      message.type === "runtime.start");
    if (start?.type !== "runtime.start") {
      throw new Error("Expected the manual-recovery runtime to start.");
    }
    await vi.advanceTimersByTimeAsync(1_900);
    children[0].emit("message", {
      type: "runtime.modern-darwin-recovery-authority-acknowledged",
      operationId: descriptor!.operationId,
      snapshotDigest: descriptor!.snapshotDigest,
      currentRuntimeGenerationId: start.options.runtimeGenerationId,
    });
    // Exact recovery progress owns one fresh startup window. A loaded host
    // may need the first window to retire the old generation before ordinary
    // runtime initialization can finish.
    await vi.advanceTimersByTimeAsync(200);
    expect(supervisor.snapshot().lastError).toBeNull();
    children[0].emit("message", {
      type: "runtime.ready",
      websocketUrl: firstUrl,
    });

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
