// @inertia-test-suite portable
import { EventEmitter } from "node:events";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor, type RuntimeSupervisorOptions } from "../../src/main/runtime-supervisor";
import { RuntimeConnectionUnavailableError } from
  "../../src/main/runtime-supervisor-connection";
import { runtimeSupervisorDefaults } from
  "../../src/main/runtime-supervisor-values";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";
import { recoverRuntimeOwnedProcesses } from "../../src/main/runtime-owned-process-recovery";
import {
  encodeConversationAttachmentStoreOperation,
  type ConversationAttachmentStoreAnyOperationRunner,
  type ConversationAttachmentStoreAuthority,
} from "../../src/node/conversation-attachment-store-child";
import type { RuntimeOwnedProcessContainment } from
  "../../src/node/runtime-owned-processes";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

const runtimeUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
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

  kill(): boolean { return true; }
  spawn(): void { this.emit("spawn"); }
  message(value: unknown): void { this.emit("message", value); }
  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

function createHarness(options: {
  onRestartRequested?: RuntimeSupervisorOptions["onRestartRequested"];
  platform?: NodeJS.Platform;
  runtimeProcessGuardianPath?: string;
  startupTimeoutMs?: number;
  recoverOwnedProcesses?: (
    runtimeGenerationId: string,
    systemBootId: string,
    deadlineAt: number,
  ) => boolean | Promise<boolean> | null;
  armProcessContainment?: () =>
    RuntimeOwnedProcessContainment
    | Promise<RuntimeOwnedProcessContainment | null>
    | null;
  spawn?: () => never;
  conversationAttachmentStoreRunner?: ConversationAttachmentStoreAnyOperationRunner;
  conversationAttachmentStoreAuthority?: ConversationAttachmentStoreAuthority;
} = {}): {
  children: FakeUtilityProcess[];
  forceKill: ReturnType<typeof vi.fn<(pid: number, deadlineAt: number) => boolean>>;
  supervisor: RuntimeSupervisor;
} {
  const children: FakeUtilityProcess[] = [];
  const forceKill = vi.fn((_pid: number, _deadlineAt: number) => true);
  const supervisor = new RuntimeSupervisor({
    onRestartRequested: options.onRestartRequested,
    platform: options.platform,
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: resolve(tmpdir(), "inertia workspace"),
      enableProviders: false,
      runtimeProcessGuardianPath: options.runtimeProcessGuardianPath,
    },
    spawn: options.spawn ?? (() => {
      const child = new FakeUtilityProcess(10_000 + children.length);
      children.push(child);
      return child as never;
    }),
    startupTimeoutMs: options.startupTimeoutMs ?? 2_000,
    stableUptimeMs: 5_000,
    shutdownGraceMs: 1_000,
    forceKillWaitMs: 500,
    forceKill,
    recoverOwnedProcesses: options.recoverOwnedProcesses ?? (() => true),
    armProcessContainment: options.armProcessContainment ?? (() =>
      process.platform === "win32"
        ? {
            kind: "windows-job-v1",
            name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
          }
        : null),
    conversationAttachmentStoreRunner: options.conversationAttachmentStoreRunner,
    conversationAttachmentStoreAuthority:
      options.conversationAttachmentStoreAuthority,
  });
  return { children, forceKill, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-supervisor-lifecycle-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("RuntimeSupervisor lifecycle", () => {
  it.each(["linux", "darwin", "win32"] as const)("uses the injected %s recovery policy throughout an unexpected exit", async (platform) => {
    const deadlines: number[] = [];
    const { children, supervisor } = createHarness({
      platform, runtimeProcessGuardianPath: resolve(dataDirectory, "test-guardian"),
      recoverOwnedProcesses: (_generation, _boot, deadline) => { deadlines.push(deadline); return false; },
    });
    supervisor.start(); children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    await vi.advanceTimersByTimeAsync(0);
    const exitedAt = Date.now();
    children[0].exit(17);
    await vi.advanceTimersByTimeAsync(0);
    expect(deadlines).toEqual([exitedAt + (platform === "win32" ? 6_000 : 1_000)]);
    expect(supervisor.canResumeWithModernDarwinRecovery()).toBe(platform === "darwin");
    expect(supervisor.snapshot().restartScheduled).toBe(platform !== "darwin");
  });

  it("restarts a macOS runtime without the explicit recovery sheet when exact recovery succeeds", async () => {
    const { children, supervisor } = createHarness({
      platform: "darwin", runtimeProcessGuardianPath: resolve(dataDirectory, "test-guardian"),
      recoverOwnedProcesses: () => true,
    });
    supervisor.start(); children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    await vi.advanceTimersByTimeAsync(0);
    children[0].exit(17);
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.canResumeWithModernDarwinRecovery()).toBe(false);
    expect(supervisor.snapshot().restartScheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
  });

  it.each([0, 10_000])("bounds repeated containment failures after exact cleanup takes %i ms", async (cleanupDelay) => {
    const { children, supervisor } = createHarness({ platform: "linux" });
    supervisor.start();
    for (let index = 0; index < 10; index += 1) {
      const child = children[index];
      if (!child) break;
      child.spawn();
      child.message({ type: "runtime.ready", websocketUrl: runtimeUrl });
      await vi.advanceTimersByTimeAsync(3_000);
      child.message({ type: "runtime.restart-requested", reason: "owned-process-tainted",
        diagnostic: { stage: "linux-admission" } });
      expect(() => supervisor.connection()).toThrow(RuntimeConnectionUnavailableError);
      child.message({ type: "runtime.ready", websocketUrl: runtimeUrl });
      expect(supervisor.snapshot().phase).toBe("restarting");
      await vi.advanceTimersByTimeAsync(cleanupDelay);
      child.message({ type: "runtime.stopped" });
      child.exit(1);
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(children.length).toBeLessThanOrEqual(4);
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", restartScheduled: false });
    expect(supervisor.snapshot().lastError).toContain("linux-admission");
    expect(() => supervisor.connection()).toThrow(RuntimeConnectionUnavailableError);
    const count = children.length;
    await vi.advanceTimersByTimeAsync(120_000);
    supervisor.start();
    expect(children).toHaveLength(count);
  });

  it("keeps session proof when a spawn failure cannot retire its lease", () => {
    const consume = vi.spyOn(
      RuntimeGenerationLeaseJournal.prototype,
      "consume",
    ).mockReturnValueOnce(false);
    const { supervisor } = createHarness({
      spawn: () => { throw new Error("simulated spawn failure"); },
    });
    try {
      supervisor.start();
      const leases = new RuntimeGenerationLeaseJournal(dataDirectory).all();
      expect(leases).toHaveLength(1);
      const generationId = leases[0]!.runtimeGenerationId;
      expect(new RuntimeOwnedProcessJournal(dataDirectory)
        .sessionExact(generationId)).not.toBeNull();
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        restartScheduled: false,
      });
    } finally {
      consume.mockRestore();
    }
  });

  it("leaves a repairable unleased session when spawn rollback cannot finish it", () => {
    const finish = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "finishSession",
    ).mockReturnValueOnce(false);
    const { supervisor } = createHarness({
      spawn: () => { throw new Error("simulated spawn failure"); },
    });
    try {
      supervisor.start();
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
      const generationId = finish.mock.calls[0]?.[0];
      expect(generationId).toEqual(expect.any(String));
      expect(new RuntimeOwnedProcessJournal(dataDirectory)
        .sessionExact(generationId!)).not.toBeNull();
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        restartScheduled: false,
      });
    } finally {
      finish.mockRestore();
    }
  });

  it("retries closed Linux cleanup after the exact attachment helper exits", async () => {
    let rejectResult!: (error: Error) => void;
    let rejectStopped!: (error: Error) => void;
    let resolveTermination!: () => void;
    const authority = {
      root: resolve(tmpdir(), "conversation-attachments"),
      dev: "1", ino: "2", uid: "501",
    };
    const runner = vi.fn((_operation: unknown, signal?: AbortSignal) => {
      const result = new Promise<void>((_resolve, reject) => { rejectResult = reject; });
      signal?.addEventListener("abort", () => rejectResult(new Error("cancelled")), { once: true });
      const stopped = new Promise<void>((_resolve, reject) => { rejectStopped = reject; });
      const termination = new Promise<void>((resolveTerminationPromise) => {
        resolveTermination = resolveTerminationPromise;
      });
      return { result, stopped, termination, ready: Promise.resolve(false) };
    });
    const recoverOwnedProcesses = vi.fn(() => true);
    const { children, supervisor } = createHarness({
      platform: "linux", conversationAttachmentStoreRunner: runner as never,
      conversationAttachmentStoreAuthority: authority, recoverOwnedProcesses,
    });
    supervisor.start(); children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    children[0].message({
      type: "runtime.conversation-attachment-store-request",
      requestId: crypto.randomUUID(),
      encodedOperation: encodeConversationAttachmentStoreOperation({
        operation: "remove", root: authority.root, rootDev: authority.dev,
        rootIno: authority.ino, rootUid: authority.uid, name: crypto.randomUUID(),
      }),
    });

    const firstStop = supervisor.stop();
    children[0].message({ type: "runtime.stopped" }); children[0].exit(0);
    rejectStopped(new Error("utility exit unconfirmed"));
    await expect(firstStop).resolves.toBe(false);
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped",
      lastError: "Conversation attachment storage shutdown could not be confirmed." });
    resolveTermination(); await Promise.resolve();
    await expect(supervisor.stop()).resolves.toBe(true);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", lastError: null });
    expect(recoverOwnedProcesses).toHaveBeenCalledOnce();
  });

  it.each([
    ["locks the replacement while", false, true],
    ["does not lock the replacement once", true, undefined],
  ] as const)("%s an exited generation's attachment helper cleanup is unconfirmed", async (_label, helperStops, locked) => {
    let rejectResult!: (error: Error) => void;
    let rejectStopped!: (error: Error) => void;
    let resolveTermination!: () => void;
    const authority = {
      root: resolve(tmpdir(), "conversation-attachments"),
      dev: "1", ino: "2", uid: "501",
    };
    const runner = vi.fn((_operation: unknown, signal?: AbortSignal) => {
      const result = new Promise<void>((_resolve, reject) => { rejectResult = reject; });
      signal?.addEventListener("abort", () => rejectResult(new Error("cancelled")), { once: true });
      const stopped = new Promise<void>((_resolve, reject) => { rejectStopped = reject; });
      const termination = new Promise<void>((resolveTerminationPromise) => {
        resolveTermination = resolveTerminationPromise;
      });
      return { result, stopped, termination, ready: Promise.resolve(false) };
    });
    const { children, supervisor } = createHarness({
      platform: "linux", conversationAttachmentStoreRunner: runner as never,
      conversationAttachmentStoreAuthority: authority, recoverOwnedProcesses: () => false,
    });
    supervisor.start(); children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    children[0].message({
      type: "runtime.conversation-attachment-store-request",
      requestId: crypto.randomUUID(),
      encodedOperation: encodeConversationAttachmentStoreOperation({
        operation: "remove", root: authority.root, rootDev: authority.dev,
        rootIno: authority.ino, rootUid: authority.uid, name: crypto.randomUUID(),
      }),
    });
    children[0].message({ type: "runtime.shutdown-unconfirmed", reason: "owned-process-cleanup" });
    children[0].exit(137);
    rejectStopped(new Error("utility exit unconfirmed"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped",
      lastError: "Conversation attachment storage shutdown could not be confirmed." });
    if (helperStops) {
      resolveTermination();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(supervisor.restartFromUser()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    children[1].spawn();
    expect(startOptions(children[1]).priorRuntimeCleanupUnconfirmed).toBe(locked);
  });

  it("keeps arbitrary child errors private across every unavailable operation", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    const privateLocation =
      "/mnt/customer/roadmap.txt?prompt=TOP_SECRET&token=ghp_private";
    children[0].emit("error", "spawn", privateLocation);
    expect(supervisor.snapshot().lastError).toContain(privateLocation);

    const failures: unknown[] = [];
    for (const operation of [
      () => supervisor.connection(),
      () => supervisor.detachedConnection(crypto.randomUUID(), "renderer:1"),
    ]) {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    }
    const pending = await Promise.allSettled([
      supervisor.resolveProjectPath({} as never),
      supervisor.databaseRecovery("export", privateLocation),
      supervisor.privateConnectRequest({} as never, {} as never),
      supervisor.preparePrivateConnectPrompt({} as never, {} as never),
      supervisor.commitPrivateConnectPrompt(
        {} as never,
        {} as never,
        crypto.randomUUID(),
      ),
    ]);
    failures.push(...pending.map((result) =>
      result.status === "rejected" ? result.reason : null));

    expect(failures).toHaveLength(7);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(RuntimeConnectionUnavailableError);
      const projection = (failure as RuntimeConnectionUnavailableError)
        .connection;
      expect(projection).toMatchObject({
        code: "runtime-starting",
        retryable: true,
      });
      expect(JSON.stringify(projection)).not.toContain("customer");
      expect(JSON.stringify(projection)).not.toContain("TOP_SECRET");
      expect(JSON.stringify(projection)).not.toContain("ghp_private");
    }
  });

  it("keeps recovery startup alive through the bounded Intel headroom", async () => {
    expect(runtimeSupervisorDefaults.startupTimeoutMs).toBe(30_000);
    const { children, forceKill, supervisor } = createHarness({
      startupTimeoutMs: runtimeSupervisorDefaults.startupTimeoutMs,
    });
    supervisor.start();
    children[0].spawn();

    await vi.advanceTimersByTimeAsync(25_000);
    expect(forceKill).not.toHaveBeenCalled();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready" });
  });

  it("recovers exact owned claims after an unconfirmed close before restarting", async () => {
    const recoverOwnedProcesses = vi.fn(async () => true);
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    children[0].message({
      type: "runtime.shutdown-unconfirmed",
      reason: "owned-process-cleanup",
    });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "restarting",
      websocketUrl: null,
    });
    expect(() => supervisor.connection()).toThrow(
      "The local service is restarting. Try again in a moment.",
    );
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);

    expect(recoverOwnedProcesses).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}:1$/u),
      "test:00000000-0000-4000-8000-000000000001",
      expect.any(Number),
    );
    expect(children).toHaveLength(2);
    children[1].spawn();
    expect(children[1].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        confirmedTerminatedRuntimeGenerationIds: [
          expect.stringMatching(/^[0-9a-f-]{36}:1$/u),
        ],
      },
    });
    expect(children[1].messages.at(-1)).not.toMatchObject({
      options: { priorRuntimeCleanupUnconfirmed: true },
    });
  });

  it("finishes exact cleanup when app shutdown receives an unconfirmed close", async () => {
    const recoverOwnedProcesses = vi.fn(() => true);
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    const start = children[0].messages.find(
      (message) => message.type === "runtime.start",
    );
    if (start?.type !== "runtime.start") {
      throw new Error("Expected the runtime generation to start.");
    }
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    const stopped = supervisor.stop();
    children[0].message({
      type: "runtime.shutdown-unconfirmed",
      reason: "owned-process-cleanup",
    });
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(0);

    await expect(stopped).resolves.toBe(true);
    expect(recoverOwnedProcesses).toHaveBeenCalledWith(
      start.options.runtimeGenerationId,
      "test:00000000-0000-4000-8000-000000000001",
      expect.any(Number),
    );
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
    expect(new RuntimeOwnedProcessJournal(dataDirectory)
      .sessionExact(start.options.runtimeGenerationId)).toBeNull();
  });

  it("settles stop when pending exact cleanup recovery fails", async () => {
    let resolveRecovery!: (recovered: boolean) => void;
    const recoverOwnedProcesses = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRecovery = resolve;
    }));
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    children[0].message({
      type: "runtime.shutdown-unconfirmed",
      reason: "owned-process-cleanup",
    });
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = supervisor.stop();
    resolveRecovery(false);
    await vi.advanceTimersByTimeAsync(0);

    await expect(stopped).resolves.toBe(false);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      restartScheduled: false,
    });
  });

  it("stays blocked instead of starting a safety-locked replacement", async () => {
    const recoverOwnedProcesses = vi.fn(() => false);
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    children[0].message({
      type: "runtime.shutdown-unconfirmed",
      reason: "owned-process-cleanup",
    });
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(recoverOwnedProcesses).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      restartScheduled: false,
    });
  });

  it("retains unexpected-exit cleanup authority when the journal directory disappears", async () => {
    const { children, supervisor } = createHarness({
      recoverOwnedProcesses: (generation, boot, deadlineAt) =>
        recoverRuntimeOwnedProcesses(dataDirectory, generation, boot, { deadlineAt }),
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    const start = children[0].messages.find((message) => message.type === "runtime.start");
    if (start?.type !== "runtime.start") throw new Error("Missing runtime start command.");
    const generation = start.options.runtimeGenerationId!;
    const movedDirectory = `${dataDirectory}-temporarily-unavailable`;
    renameSync(dataDirectory, movedDirectory);
    try {
      expect(() => children[0].exit(137)).not.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(children).toHaveLength(1);
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped", restartScheduled: false, websocketUrl: null,
      });
      await expect(supervisor.stop()).resolves.toBe(false);
    } finally {
      renameSync(movedDirectory, dataDirectory);
    }
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ runtimeGenerationId: generation })]),
    );
    expect(new RuntimeOwnedProcessJournal(dataDirectory).sessionExact(generation)).not.toBeNull();
  });

  it("settles stop when unexpected-exit recovery throws synchronously", async () => {
    const { children, supervisor } = createHarness({
      recoverOwnedProcesses: () => { throw new Error("journal unavailable"); },
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    const settled = expect(supervisor.stop()).resolves.toBe(false);
    expect(() => children[0].exit(137)).not.toThrow();
    await settled;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped", restartScheduled: false, websocketUrl: null,
    });
  });

  it("fails closed when exact cleanup recovery throws synchronously", async () => {
    const recoverOwnedProcesses = vi.fn((): boolean => {
      throw new Error("journal unavailable");
    });
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    children[0].message({
      type: "runtime.shutdown-unconfirmed",
      reason: "owned-process-cleanup",
    });
    expect(() => children[0].exit(137)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      restartScheduled: false,
    });
  });

  it("starts readiness timing after slow asynchronous containment admission", async () => {
    let resolveContainment!: (
      containment: RuntimeOwnedProcessContainment | null,
    ) => void;
    const containmentPending =
      new Promise<RuntimeOwnedProcessContainment | null>((resolve) => {
        resolveContainment = resolve;
      });
    const { children, forceKill, supervisor } = createHarness({
      startupTimeoutMs: 20_000,
      armProcessContainment: () => containmentPending,
    });
    supervisor.start();
    children[0].spawn();

    await vi.advanceTimersByTimeAsync(32_751);
    expect(children[0].messages).not.toContainEqual(expect.objectContaining({
      type: "runtime.start",
    }));
    expect(forceKill).not.toHaveBeenCalled();

    resolveContainment(process.platform === "win32"
      ? {
          kind: "windows-job-v1",
          name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
        }
      : null);
    await Promise.resolve();
    await Promise.resolve();
    expect(children[0].messages).toContainEqual(expect.objectContaining({
      type: "runtime.start",
    }));

    await vi.advanceTimersByTimeAsync(19_999);
    expect(forceKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));
    expect(() => supervisor.connection()).toThrow(
      "The local service is starting. Try again in a moment.",
    );
  });

  it("is single-use after a complete owned-generation shutdown", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const start = children[0].messages.find(
      (message) => message.type === "runtime.start",
    );
    if (start?.type !== "runtime.start") {
      throw new Error("Expected the first runtime generation to start.");
    }
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    const firstStop = supervisor.stop();
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    await expect(firstStop).resolves.toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
    expect(new RuntimeOwnedProcessJournal(dataDirectory)
      .records(start.options.runtimeGenerationId)).toBeNull();

    supervisor.start();
    const secondStop = supervisor.stop();

    expect(secondStop).toBe(firstStop);
    await expect(secondStop).resolves.toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0].messages.filter(
      (message) => message.type === "runtime.shutdown",
    )).toHaveLength(1);
    expect(forceKill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 1,
      pid: null,
      restartScheduled: false,
    });
  });

  it("preserves the bounded owned-process-cleanup-unconfirmed restart reason", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    children[0].message({ type: "runtime.restart-requested", reason: "owned-process-cleanup-unconfirmed" });
    children[0].exit(1);

    expect(supervisor.snapshot()).toMatchObject({
      phase: "restarting",
      lastError: "The runtime restarted because owned process cleanup could not be confirmed.",
    });
  });

  it("reports the first restart cause once even when diagnostics throws", () => {
    const onRestartRequested = vi.fn(() => { throw new Error("diagnostic failure"); });
    const { children, supervisor } = createHarness({ onRestartRequested });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    const first = { type: "runtime.restart-requested", reason: "owned-process-tainted",
      diagnostic: { stage: "darwin-guardian-close", signal: "SIGUSR2" } };
    children[0].message(first);
    children[0].message({ type: "runtime.restart-requested", reason: "owned-process-cleanup-unconfirmed" });
    children[0].message({ type: "runtime.shutdown-unconfirmed", reason: "owned-process-cleanup" });
    children[0].exit(1);
    expect(onRestartRequested).toHaveBeenCalledExactlyOnceWith(first, 1);
    expect(supervisor.snapshot().lastError).toBe(
      "The runtime restarted because owned process containment could not be confirmed."
      + " (stage=darwin-guardian-close, signal=SIGUSR2)"
      + " Runtime shutdown could not confirm owned-process cleanup.",
    );
  });

  it("preserves the first startup failure and fatal cleanup outcome across repeated events", () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start(); children[0].spawn();
    children[0].message({ type: "runtime.startup-failed", message: "Runtime initialization failed (git-timeout)." });
    const shutdown = { type: "runtime.shutdown-unconfirmed", reason: "incomplete-startup" };
    children[0].message(shutdown);
    const expected = "Runtime initialization failed (git-timeout)."
      + " Runtime shutdown could not confirm cleanup after incomplete startup.";
    expect(supervisor.snapshot()).toMatchObject({ phase: "restarting", lastError: expected });
    expect(forceKill).toHaveBeenCalled();
    expect(() => supervisor.connection()).toThrow(RuntimeConnectionUnavailableError);
    for (let index = 0; index < 20; index += 1) children[0].message(shutdown);
    children[0].message({ type: "runtime.startup-failed", message: "The local runtime could not start." });
    expect(supervisor.snapshot().lastError).toBe(expected);
    children[0].exit(1);
    expect(supervisor.snapshot().lastError).toBe(expected);
  });

  it("keeps the validated first admission stage when startup rejects after a taint restart", () => {
    const onRestartRequested = vi.fn();
    const { children, forceKill, supervisor } = createHarness({ onRestartRequested });
    supervisor.start(); children[0].spawn();
    const first = { type: "runtime.restart-requested", reason: "owned-process-tainted",
      diagnostic: { stage: "darwin-readiness", signal: "SIGKILL", exitCode: 1 } };
    children[0].message(first);
    children[0].message({ type: "runtime.startup-failed", message: "Runtime initialization failed (git-cleanup-unconfirmed)." });
    children[0].message({ type: "runtime.restart-requested", reason: "owned-process-tainted",
      diagnostic: { stage: "darwin-guardian-close", signal: "SIGUSR2" } });
    children[0].message({ type: "runtime.shutdown-unconfirmed", reason: "incomplete-startup" });
    children[0].exit(1);
    expect(onRestartRequested).toHaveBeenCalledExactlyOnceWith(first, 1);
    expect(forceKill).toHaveBeenCalled();
    expect(supervisor.snapshot().lastError).toBe(
      "The runtime restarted because owned process containment could not be confirmed."
      + " (stage=darwin-readiness, signal=SIGKILL, exit-code=1)"
      + " Runtime shutdown could not confirm cleanup after incomplete startup.",
    );
  });

  it("does not start after shutdown closes an unused supervisor", async () => {
    const { children, forceKill, supervisor } = createHarness();

    const firstStop = supervisor.stop();
    await expect(firstStop).resolves.toBe(true);
    supervisor.start();

    expect(supervisor.stop()).toBe(firstStop);
    expect(children).toHaveLength(0);
    expect(forceKill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 0,
      pid: null,
      restartScheduled: false,
    });
  });
});

function startOptions(child: FakeUtilityProcess) {
  const start = child.messages.findLast((message) => message.type === "runtime.start");
  if (start?.type !== "runtime.start") throw new Error("Expected a runtime start command.");
  return start.options;
}

describe("RuntimeSupervisor restart reconciliation", () => {
  it("reconciles exact owned cleanup before restarting after a confirmed tree kill", async () => {
    const recoverOwnedProcesses = vi.fn(() => true);
    const { children, supervisor } = createHarness({ platform: "linux", recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    const firstGeneration = startOptions(children[0]).runtimeGenerationId;
    await vi.advanceTimersByTimeAsync(2_000);
    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverOwnedProcesses).toHaveBeenCalledWith(
      firstGeneration, "test:00000000-0000-4000-8000-000000000001", expect.any(Number));
    await vi.advanceTimersByTimeAsync(500);
    expect(children).toHaveLength(2);
    children[1].spawn();
    const replacement = startOptions(children[1]);
    expect(replacement.priorRuntimeCleanupUnconfirmed).toBeUndefined();
    expect(replacement.confirmedTerminatedRuntimeGenerationIds).toEqual([firstGeneration]);
  });

  it("reconciles a quarantined generation again before the scheduled replacement starts", async () => {
    const recoverOwnedProcesses = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValue(true);
    const { children, supervisor } = createHarness({ platform: "linux", recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    const firstGeneration = startOptions(children[0]).runtimeGenerationId;
    await vi.advanceTimersByTimeAsync(2_000);
    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(recoverOwnedProcesses).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
    children[1].spawn();
    const replacement = startOptions(children[1]);
    expect(replacement.priorRuntimeCleanupUnconfirmed).toBeUndefined();
    expect(replacement.confirmedTerminatedRuntimeGenerationIds).toEqual([firstGeneration]);
  });

  it("names an exited generation with unconfirmed child cleanup instead of safety-locking its replacement", async () => {
    const recoverOwnedProcesses = vi.fn(() => false);
    const { children, supervisor } = createHarness({ platform: "linux", recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    const firstGeneration = startOptions(children[0]).runtimeGenerationId;
    await vi.advanceTimersByTimeAsync(2_000);
    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(children).toHaveLength(2);
    children[1].spawn();
    const replacement = startOptions(children[1]);
    expect(replacement.priorRuntimeCleanupUnconfirmed).toBeUndefined();
    expect(replacement.exitedUnconfirmedRuntimeGenerationIds).toEqual([firstGeneration]);
  });

  it.each(["linux", "darwin", "win32"] as const)("restarts from the app on %s after automatic restarts stop", async (platform) => {
    const { children, supervisor } = createHarness({ platform });
    supervisor.start();
    for (let index = 0; index < 4; index += 1) {
      children[index]!.spawn();
      children[index]!.message({ type: "runtime.stopped" });
      children[index]!.exit(1);
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(children).toHaveLength(4);
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", restartScheduled: false });
    expect(supervisor.canRestartFromUser()).toBe(true);
    let unavailable: unknown;
    try { supervisor.connection(); } catch (error) { unavailable = error; }
    expect((unavailable as RuntimeConnectionUnavailableError).connection).toMatchObject({
      code: "runtime-stopped", restartable: true,
    });
    expect((unavailable as RuntimeConnectionUnavailableError).connection.message).not.toMatch(/restarting Inertia|restart your computer/iu);

    expect(supervisor.restartFromUser()).toBe(true);
    expect(children).toHaveLength(5);
    expect(supervisor.snapshot()).toMatchObject({ phase: "starting", restartAttempt: 0, lastError: null });
    children[4]!.spawn();
    const restarted = startOptions(children[4]!);
    for (const receiptRuntimeGenerationId of restarted.confirmedTerminatedRuntimeGenerationIds ?? []) {
      children[4]!.message({ type: "runtime.cleanup-receipt-consumed", receiptRuntimeGenerationId,
        currentRuntimeGenerationId: restarted.runtimeGenerationId });
    }
    children[4]!.message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    expect(supervisor.connection()).toEqual({ websocketUrl: runtimeUrl });
    expect(supervisor.restartFromUser()).toBe(false);
  });

  it("tells a detached chat window to restart from the main window", async () => {
    const { children, supervisor } = createHarness({ platform: "linux" });
    supervisor.start();
    for (let index = 0; index < 4; index += 1) {
      children[index]!.spawn();
      children[index]!.message({ type: "runtime.stopped" });
      children[index]!.exit(1);
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(supervisor.canRestartFromUser()).toBe(true);
    let unavailable: unknown;
    try { supervisor.detachedConnection(crypto.randomUUID(), "renderer:1"); } catch (error) { unavailable = error; }
    expect(unavailable).toBeInstanceOf(RuntimeConnectionUnavailableError);
    expect((unavailable as RuntimeConnectionUnavailableError).connection).toEqual({
      unavailable: true, code: "runtime-stopped", retryable: false,
      message: "The local service stopped. Restart it from the main window.",
    });
  });

  it("restarts from the app after an unconfirmed exit and names the exited generation", async () => {
    const { children, supervisor } = createHarness({ platform: "linux", recoverOwnedProcesses: () => false });
    supervisor.start();
    children[0].spawn();
    const firstGeneration = startOptions(children[0]).runtimeGenerationId;
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    children[0].message({ type: "runtime.shutdown-unconfirmed", reason: "owned-process-cleanup" });
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot().phase).toBe("stopped");

    expect(supervisor.restartFromUser()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    children[1].spawn();
    expect(startOptions(children[1]).priorRuntimeCleanupUnconfirmed).toBeUndefined();
    expect(startOptions(children[1]).exitedUnconfirmedRuntimeGenerationIds).toEqual([firstGeneration]);
  });

  it("does not restart from the app before start, after quit, or past the boot recovery gate", async () => {
    const unused = createHarness();
    expect(unused.supervisor.canRestartFromUser()).toBe(false);
    expect(unused.supervisor.restartFromUser()).toBe(false);
    expect(unused.children).toHaveLength(0);

    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const stopped = supervisor.stop();
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    await expect(stopped).resolves.toBe(true);
    expect(supervisor.restartFromUser()).toBe(false);
    expect(children).toHaveLength(1);

    const gated = new RuntimeSupervisor({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      workerOptions: { dataDirectory, defaultWorkspacePath: resolve(tmpdir(), "inertia workspace"), enableProviders: false },
      spawn: () => { throw new Error("must not spawn"); },
      runtimeRecoveryBlocked: true,
    });
    gated.start();
    expect(gated.restartFromUser()).toBe(false);
    expect(gated.snapshot().phase).toBe("stopped");
  });

  it("confirms the first quit after a quarantined generation becomes recoverable", async () => {
    const recoverOwnedProcesses = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValue(true);
    const { children, supervisor } = createHarness({ platform: "linux", recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    await vi.advanceTimersByTimeAsync(2_000);
    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(supervisor.stop()).resolves.toBe(true);
    expect(children).toHaveLength(1);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", lastError: null });
  });

  it("confirms quit of a clean generation after reconciling an earlier quarantined one", async () => {
    const recoverOwnedProcesses = vi.fn<() => boolean>()
      .mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const { children, supervisor } = createHarness({ platform: "linux", recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    await vi.advanceTimersByTimeAsync(2_000);
    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(500);
    children[1].spawn();
    children[1].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    const stopped = supervisor.stop();
    children[1].message({ type: "runtime.stopped" });
    children[1].exit(0);
    await expect(stopped).resolves.toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
  });
});
