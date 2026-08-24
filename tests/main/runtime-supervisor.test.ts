import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeSupervisor,
  runtimeRestartDelayMs,
  type RuntimeAttachmentBroker,
  type RuntimeCredentialBroker,
  type RuntimeSecureFileBroker,
} from "../../src/main/runtime-supervisor";
import { RuntimeCleanupReceiptJournal } from "../../src/main/runtime-cleanup-receipts";
import {
  encodeConversationAttachmentStoreOperation,
  type ConversationAttachmentStoreAnyOperationRunner,
  type ConversationAttachmentStoreAuthority,
} from "../../src/node/conversation-attachment-store-child";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";
import {
  privateConnectRuntimeGrantsFromProjectIds,
} from "../../src/shared/private-connect/runtime-grants";

const firstUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const secondUrl = `ws://127.0.0.1:41002/runtime/${"b".repeat(43)}`;
let dataDirectory: string;
const workspaceDirectory = resolve(tmpdir(), "inertia workspace");
const attachmentId = "33333333-3333-4333-8333-333333333333";
const attachmentHandoffId = "44444444-4444-4444-8444-444444444444";
const trustedAttachment = {
  id: attachmentId,
  name: "preview.png",
  path: resolve(tmpdir(), "inertia attachments", `${attachmentId}.png`),
  mimeType: "image/png" as const,
  size: 8,
  digest: "a".repeat(64),
};
const projectPathRequest = {
  projectId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  relativePath: "src/index.ts",
  action: "open-externally" as const,
};
const conversationAttachmentStoreAuthority: ConversationAttachmentStoreAuthority = {
  root: resolve(tmpdir(), "conversation-attachments"),
  dev: "1",
  ino: "2",
  uid: "501",
};

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined;
  readonly messages: RuntimeWorkerCommand[] = [];
  killCalls = 0;
  postError: Error | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  postMessage(message: RuntimeWorkerCommand): void {
    if (this.postError) throw this.postError;
    this.messages.push(message);
  }

  kill(): boolean {
    this.killCalls += 1;
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
        for (const receiptRuntimeGenerationId of
          start.options.confirmedTerminatedRuntimeGenerationIds ?? []) {
          this.emit("message", {
            type: "runtime.cleanup-receipt-consumed",
            receiptRuntimeGenerationId,
            currentRuntimeGenerationId: start.options.runtimeGenerationId,
          });
        }
      }
    }
    this.emit("message", value);
  }
  rawMessage(value: unknown): void { this.emit("message", value); }
  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

function createHarness(options: {
  stableUptimeMs?: number;
  shutdownGraceMs?: number;
  forceKillWaitMs?: number;
  recoverOwnedProcesses?: (
    runtimeGenerationId: string,
    systemBootId: string,
    deadlineAt: number,
  ) => boolean | Promise<boolean> | null;
  credentialBroker?: RuntimeCredentialBroker;
  credentialRequestTimeoutMs?: number;
  secureFileBroker?: RuntimeSecureFileBroker;
  conversationAttachmentStoreRunner?: ConversationAttachmentStoreAnyOperationRunner;
  conversationAttachmentStoreAuthority?: ConversationAttachmentStoreAuthority;
  attachmentBroker?: RuntimeAttachmentBroker;
  attachmentRequestTimeoutMs?: number;
  databaseRecoveryRequestTimeoutMs?: number;
  databaseRecoveryCancelTimeoutMs?: number;
} = {}) {
  const children: FakeUtilityProcess[] = [];
  const forceKill = vi.fn((
    _pid: number,
    _deadlineAt: number,
  ): boolean | Promise<boolean> => true);
  const supervisor = new RuntimeSupervisor({
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: workspaceDirectory,
      enableProviders: false,
    },
    spawn: () => {
      const child = new FakeUtilityProcess(10_000 + children.length);
      children.push(child);
      return child as never;
    },
    startupTimeoutMs: 2_000,
    stableUptimeMs: options.stableUptimeMs ?? 5_000,
    shutdownGraceMs: options.shutdownGraceMs ?? 1_000,
    forceKillWaitMs: options.forceKillWaitMs ?? 500,
    forceKill,
    // Generic tests model exact cleanup; fail-closed cases override it below.
    recoverOwnedProcesses: options.recoverOwnedProcesses ?? (() => true),
    credentialBroker: options.credentialBroker,
    credentialRequestTimeoutMs: options.credentialRequestTimeoutMs,
    secureFileBroker: options.secureFileBroker,
    conversationAttachmentStoreRunner: options.conversationAttachmentStoreRunner,
    conversationAttachmentStoreAuthority:
      options.conversationAttachmentStoreAuthority,
    attachmentBroker: options.attachmentBroker,
    attachmentRequestTimeoutMs: options.attachmentRequestTimeoutMs,
    databaseRecoveryRequestTimeoutMs: options.databaseRecoveryRequestTimeoutMs,
    databaseRecoveryCancelTimeoutMs: options.databaseRecoveryCancelTimeoutMs,
  });
  return { children, forceKill, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-supervisor-"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("RuntimeSupervisor", () => {
  it.runIf(process.platform === "linux")(
    "retires a recoverable prior app generation before spawning",
    async () => {
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
    },
  );

  it("prepares and releases only the current runtime generation for an update", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const preparing = supervisor.prepareForUpdate();
    const command = children[0].messages.findLast(
      (message) => message.type === "runtime.prepare-update",
    );
    expect(command).toMatchObject({
      type: "runtime.prepare-update",
      generation: 1,
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    if (command?.type !== "runtime.prepare-update") {
      throw new Error("Expected update preparation command.");
    }
    children[0].message({
      type: "runtime.prepare-update-result",
      operationId: command.operationId,
      generation: 2,
      ready: true,
    });
    children[0].message({
      type: "runtime.prepare-update-result",
      operationId: command.operationId,
      generation: 1,
      ready: true,
    });
    await expect(preparing).resolves.toEqual({ ready: true });

    await expect(supervisor.prepareForUpdate()).resolves.toEqual({ ready: true });
    expect(children[0].messages.filter(
      (message) => message.type === "runtime.prepare-update",
    )).toHaveLength(1);

    const releasing = supervisor.releaseUpdatePreparation();
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.release-update-preparation",
      operationId: command.operationId,
      generation: 1,
    });
    children[0].message({
      type: "runtime.release-update-preparation-result",
      operationId: command.operationId,
      generation: 1,
      released: true,
    });
    await expect(releasing).resolves.toBe(true);
    await expect(supervisor.releaseUpdatePreparation()).resolves.toBe(true);
  });

  it("returns sanitized update preparation blockers without retaining a gate", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const preparing = supervisor.prepareForUpdate();
    const command = children[0].messages.at(-1);
    if (command?.type !== "runtime.prepare-update") {
      throw new Error("Expected update preparation command.");
    }
    children[0].message({
      type: "runtime.prepare-update-result",
      operationId: command.operationId,
      generation: command.generation,
      ready: false,
      blocker: "terminal",
    });
    await expect(preparing).resolves.toEqual({
      ready: false,
      blocker: "terminal",
    });

    const retry = supervisor.prepareForUpdate();
    const retryCommand = children[0].messages.at(-1);
    expect(retryCommand).toMatchObject({
      type: "runtime.prepare-update",
      generation: 1,
      operationId: expect.not.stringMatching(command.operationId),
    });
    if (retryCommand?.type !== "runtime.prepare-update") {
      throw new Error("Expected retry update preparation command.");
    }
    children[0].message({
      type: "runtime.prepare-update-result",
      operationId: retryCommand.operationId,
      generation: retryCommand.generation,
      ready: false,
      blocker: "runtime-operation",
    });
    await expect(retry).resolves.toEqual({
      ready: false,
      blocker: "runtime-operation",
    });
  });

  it("releases the exact preparation identity after a supervisor timeout", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const preparing = supervisor.prepareForUpdate();
    const prepareCommand = children[0].messages.at(-1);
    if (prepareCommand?.type !== "runtime.prepare-update") {
      throw new Error("Expected update preparation command.");
    }
    const rejection = expect(preparing).rejects.toThrow(
      "did not finish update preparation",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.release-update-preparation",
      operationId: prepareCommand.operationId,
      generation: prepareCommand.generation,
    });
    children[0].message({
      type: "runtime.release-update-preparation-result",
      operationId: prepareCommand.operationId,
      generation: prepareCommand.generation,
      released: true,
    });
    await Promise.resolve();
    expect(forceKill).not.toHaveBeenCalled();
  });

  it("waits for authenticated readiness before handing out a connection", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    expect(children).toHaveLength(1);
    expect(() => supervisor.connection()).toThrow("local service is starting");

    children[0].spawn();
    expect(children[0].messages).toEqual([{
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: expect.stringMatching(/^[0-9a-f-]{36}:1$/u),
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
      },
    }]);
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.connection()).toEqual({ websocketUrl: firstUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 1, pid: 10_000 });
  });

  it.each(["restored", "created-empty"] as const)(
    "delivers a %s startup recovery warning exactly once per runtime start",
    (outcome) => {
      const { children, supervisor } = createHarness();
      supervisor.start();
      children[0].spawn();
      children[0].message({
        type: "runtime.ready",
        websocketUrl: firstUrl,
        databaseRecovery: {
          checkedAt: "2026-01-01T00:00:00.000Z",
          outcome,
          trigger: "primary-corrupt",
          restoredBackup: outcome === "restored" ? "backup.sqlite" : null,
          preservedCorruptPrimary: true, preservedDatabaseFamilyMembers: 1,
          invalidBackupsSkipped: 2,
          unsupportedBackupsSkipped: 1,
        },
      });
      expect(supervisor.connection(false)).toEqual({ websocketUrl: firstUrl });
      expect(supervisor.connection()).toEqual({
        websocketUrl: firstUrl,
        databaseRecoveryNotice: {
          id: "runtime-1-database-recovery",
          outcome,
          trigger: "primary-corrupt",
          preservedCorruptPrimary: true, preservedDatabaseFamilyMembers: 1,
          invalidBackupsSkipped: 2,
          unsupportedBackupsSkipped: 1,
        },
      });
      expect(supervisor.connection()).toEqual({ websocketUrl: firstUrl });
      expect(supervisor.connection()).toEqual({ websocketUrl: firstUrl });
    },
  );

  it("does not surface a recovery warning for a clean first launch", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({
      type: "runtime.ready",
      websocketUrl: firstUrl,
      databaseRecovery: {
        checkedAt: "2026-01-01T00:00:00.000Z",
        outcome: "first-launch",
        trigger: "none",
        restoredBackup: null,
        preservedCorruptPrimary: false, preservedDatabaseFamilyMembers: 0,
        invalidBackupsSkipped: 0,
        unsupportedBackupsSkipped: 0,
      },
    });

    expect(supervisor.connection()).toEqual({ websocketUrl: firstUrl });
  });

  it("correlates bounded database recovery operations with the ready runtime", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const path = resolve(dataDirectory, "recovery.json");
    const targetDirectory = resolve(workspaceDirectory, "recovered");
    const pending = supervisor.databaseRecovery("import", path, targetDirectory);
    const request = children[0].messages.at(-1) as {
      type: string;
      operationId: string;
      generation: number;
      operation: string;
      path: string;
    };
    expect(request).toMatchObject({
      type: "runtime.database-recovery",
      generation: 1,
      operation: "import",
      path,
      targetDirectory,
    });
    children[0].message({
      type: "runtime.database-recovery-result",
      operationId: request.operationId,
      generation: request.generation,
      operation: "export",
      ok: true,
      summary: null,
    });
    children[0].message({
      type: "runtime.database-recovery-result",
      operationId: request.operationId,
      generation: request.generation + 1,
      operation: "import",
      ok: true,
      summary: {
        projects: 99,
        conversations: 99,
        messages: 99,
        alreadyImported: false,
      },
    });
    children[0].message({
      type: "runtime.database-recovery-result",
      operationId: request.operationId,
      generation: request.generation,
      operation: "import",
      ok: true,
      summary: {
        projects: 1,
        conversations: 2,
        messages: 3,
        alreadyImported: false,
      },
    });
    await expect(pending).resolves.toEqual({
      projects: 1,
      conversations: 2,
      messages: 3,
      alreadyImported: false,
    });
  });

  it("keeps recovery busy until timed-out cancellation is acknowledged", async () => {
    const { children, supervisor } = createHarness({
      databaseRecoveryRequestTimeoutMs: 100,
      databaseRecoveryCancelTimeoutMs: 50,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const pending = supervisor.databaseRecovery(
      "export",
      resolve(dataDirectory, "recovery.json"),
    );
    const request = children[0].messages.at(-1) as Extract<
      RuntimeWorkerCommand,
      { type: "runtime.database-recovery" }
    >;
    const settled = vi.fn();
    void pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(100);
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.database-recovery-cancel",
      operationId: request.operationId,
      generation: request.generation,
      operation: "export",
    });
    expect(settled).not.toHaveBeenCalled();
    await expect(supervisor.databaseRecovery(
      "export",
      resolve(dataDirectory, "retry.json"),
    )).rejects.toThrow(/already in progress/u);

    children[0].message({
      type: "runtime.database-recovery-result",
      operationId: request.operationId,
      generation: request.generation,
      operation: "export",
      ok: false,
      cancelled: true,
      message: "The database recovery operation was cancelled.",
    });
    await expect(pending).rejects.toThrow(/timed out and was cancelled/u);

    const retry = supervisor.databaseRecovery(
      "export",
      resolve(dataDirectory, "retry.json"),
    );
    const retryRequest = children[0].messages.at(-1) as Extract<
      RuntimeWorkerCommand,
      { type: "runtime.database-recovery" }
    >;
    expect(retryRequest.operationId).not.toBe(request.operationId);
    children[0].message({
      type: "runtime.database-recovery-result",
      operationId: retryRequest.operationId,
      generation: retryRequest.generation,
      operation: "export",
      ok: true,
      summary: null,
    });
    await expect(retry).resolves.toBeNull();
  });

  it("reports a completed timed-out operation truthfully instead of replaying it", async () => {
    const { children, supervisor } = createHarness({
      databaseRecoveryRequestTimeoutMs: 100,
      databaseRecoveryCancelTimeoutMs: 50,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const pending = supervisor.databaseRecovery(
      "import",
      resolve(dataDirectory, "recovery.json"),
      resolve(workspaceDirectory, "recovered"),
    );
    const request = children[0].messages.at(-1) as Extract<
      RuntimeWorkerCommand,
      { type: "runtime.database-recovery" }
    >;
    await vi.advanceTimersByTimeAsync(100);
    children[0].message({
      type: "runtime.database-recovery-result",
      operationId: request.operationId,
      generation: request.generation,
      operation: "import",
      ok: true,
      summary: {
        projects: 1,
        conversations: 1,
        messages: 1,
        alreadyImported: false,
      },
    });
    await expect(pending).resolves.toMatchObject({ alreadyImported: false });
    expect(children[0].messages.filter(
      ({ type }) => type === "runtime.database-recovery",
    )).toHaveLength(1);
  });

  it("terminates an unconfirmed cancellation and ignores late old-generation success after restart", async () => {
    const { children, forceKill, supervisor } = createHarness({
      databaseRecoveryRequestTimeoutMs: 100,
      databaseRecoveryCancelTimeoutMs: 50,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const pending = supervisor.databaseRecovery(
      "import",
      resolve(dataDirectory, "recovery.json"),
      resolve(workspaceDirectory, "recovered"),
    );
    const request = children[0].messages.at(-1) as Extract<
      RuntimeWorkerCommand,
      { type: "runtime.database-recovery" }
    >;
    await vi.advanceTimersByTimeAsync(150);
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));
    children[0].exit(1);
    await expect(pending).rejects.toThrow(/cancellation was confirmed/u);
    await vi.advanceTimersByTimeAsync(500);
    children[1].spawn();
    children[1].message({ type: "runtime.ready", websocketUrl: secondUrl });
    expect(supervisor.connection()).toEqual({ websocketUrl: secondUrl });

    children[0].message({
      type: "runtime.database-recovery-result",
      operationId: request.operationId,
      generation: request.generation,
      operation: "import",
      ok: true,
      summary: {
        projects: 1,
        conversations: 0,
        messages: 0,
        alreadyImported: false,
      },
    });
    const retry = supervisor.databaseRecovery(
      "import",
      resolve(dataDirectory, "retry.json"),
      resolve(workspaceDirectory, "recovered-retry"),
    );
    const retryRequest = children[1].messages.at(-1) as Extract<
      RuntimeWorkerCommand,
      { type: "runtime.database-recovery" }
    >;
    expect(retryRequest.generation).toBe(2);
    expect(children[1].messages.filter(
      ({ type }) => type === "runtime.database-recovery",
    )).toHaveLength(1);
    children[1].message({
      type: "runtime.database-recovery-result",
      operationId: retryRequest.operationId,
      generation: retryRequest.generation,
      operation: "import",
      ok: true,
      summary: {
        projects: 1,
        conversations: 0,
        messages: 0,
        alreadyImported: false,
      },
    });
    await expect(retry).resolves.toMatchObject({
      projects: 1,
      alreadyImported: false,
    });
  });

  it("brokers startup credentials only for the current accepted runtime generation", async () => {
    const credentialBroker: RuntimeCredentialBroker = {
      resolve: vi.fn(async () => "ephemeral-secret"),
      status: vi.fn(async () => ({
        hasSecret: true,
        credentialGeneration: "generation:test",
      })),
      clear: vi.fn(async () => false),
      forget: vi.fn(async () => false),
    };
    const { children, supervisor } = createHarness({ credentialBroker });
    supervisor.start();
    children[0].spawn();
    const secretReference = `secret:backend:${"a".repeat(64)}`;

    // Backend-profile initialization happens inside startRuntime(), before the
    // worker can publish runtime.ready. Credential status must therefore be
    // available to the current accepted startup generation.
    const statusRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.credential-request",
      requestId: statusRequestId,
      operation: "status",
      secretReference,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.credential-result",
      requestId: statusRequestId,
      operation: "status",
      ok: true,
      hasSecret: true,
      credentialGeneration: "generation:test",
    });

    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const requestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.credential-request",
      requestId,
      operation: "resolve",
      secretReference,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(credentialBroker.resolve).toHaveBeenCalledWith(
      secretReference,
      expect.any(AbortSignal),
    );
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.credential-result",
      requestId,
      operation: "resolve",
      ok: true,
      secret: "ephemeral-secret",
    });

    const forgetRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.credential-request",
      requestId: forgetRequestId,
      operation: "forget",
      secretReference,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(credentialBroker.forget).toHaveBeenCalledWith(
      secretReference,
      expect.any(AbortSignal),
    );
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.credential-result",
      requestId: forgetRequestId,
      operation: "forget",
      ok: true,
      removed: false,
    });
  });

  it("times out credential requests and ignores late results from stale generations", async () => {
    let resolveCredential: ((value: string | null) => void) | undefined;
    const credentialBroker: RuntimeCredentialBroker = {
      resolve: () => new Promise((resolveCredentialPromise) => {
        resolveCredential = resolveCredentialPromise;
      }),
      status: vi.fn(async () => ({
        hasSecret: false,
        credentialGeneration: null,
      })),
      clear: vi.fn(async () => false),
      forget: vi.fn(async () => false),
    };
    const { children, supervisor } = createHarness({
      credentialBroker,
      credentialRequestTimeoutMs: 25,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const requestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.credential-request",
      requestId,
      operation: "resolve",
      secretReference: `secret:backend:${"b".repeat(64)}`,
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.credential-result",
      requestId,
      ok: false,
      code: "unavailable",
    });

    children[0].exit(1);
    resolveCredential?.("late-secret");
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages).not.toContainEqual(expect.objectContaining({
      type: "runtime.credential-result",
      secret: "late-secret",
    }));
  });

  it("turns synchronous broker failures into fixed unavailable results", async () => {
    const credentialBroker: RuntimeCredentialBroker = {
      resolve: (() => {
        throw new Error("secret-bearing system detail");
      }) as RuntimeCredentialBroker["resolve"],
      status: vi.fn(async () => ({
        hasSecret: false,
        credentialGeneration: null,
      })),
      clear: vi.fn(async () => false),
      forget: vi.fn(async () => false),
    };
    const { children, supervisor } = createHarness({ credentialBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const requestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.credential-request",
      requestId,
      operation: "resolve",
      secretReference: `secret:backend:${"c".repeat(64)}`,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.credential-result",
      requestId,
      operation: "resolve",
      ok: false,
      code: "unavailable",
      message: "Secure credential storage is unavailable.",
    });
  });

  it("brokers validated secure-file operations once and aborts them on stop", async () => {
    let pendingSignal: AbortSignal | undefined;
    let settlePending:
      | ((value: Awaited<ReturnType<RuntimeSecureFileBroker["perform"]>>) => void)
      | undefined;
    const secureFileBroker: RuntimeSecureFileBroker = {
      perform: vi.fn<RuntimeSecureFileBroker["perform"]>((_request, signal) => {
        pendingSignal = signal;
        return new Promise<
          Awaited<ReturnType<RuntimeSecureFileBroker["perform"]>>
        >((resolvePromise) => {
          settlePending = resolvePromise;
        });
      }),
    };
    const { children, supervisor } = createHarness({ secureFileBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const requestId = crypto.randomUUID();
    const request = {
      type: "runtime.secure-file-request" as const,
      requestId,
      operation: "read" as const,
      root: workspaceDirectory,
      rootIdentity: { dev: "1", ino: "2" },
      parentIdentities: [],
      targetIdentity: { dev: "1", ino: "3" },
      path: "README.md",
      maxBytes: 1024,
    };

    children[0].message(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(secureFileBroker.perform).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "read",
        path: "README.md",
      }),
      expect.any(AbortSignal),
    );

    children[0].message(request);
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.secure-file-result",
      requestId,
      result: { ok: false, code: "invalid" },
    });

    const stopped = supervisor.stop();
    expect(pendingSignal?.aborted).toBe(true);
    settlePending?.({
      ok: false,
      code: "unavailable",
      message: "late result",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages).not.toContainEqual({
      type: "runtime.secure-file-result",
      requestId,
      result: {
        ok: false,
        code: "unavailable",
        message: "late result",
      },
    });
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    await expect(stopped).resolves.toBe(true);
  });
  it("forwards a strict secure-file recovery result to the current runtime", async () => {
    const secureFileBroker: RuntimeSecureFileBroker = {
      perform: vi.fn<RuntimeSecureFileBroker["perform"]>(
        async () => ({ ok: true, operation: "recover" }),
      ),
    };
    const { children, supervisor } = createHarness({ secureFileBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const requestId = crypto.randomUUID();

    children[0].message({
      type: "runtime.secure-file-request",
      requestId,
      operation: "recover",
      root: workspaceDirectory,
      rootIdentity: { dev: "1", ino: "2" },
      parentIdentities: [],
      path: "README.md",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(secureFileBroker.perform).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "recover",
        path: "README.md",
      }),
      expect.any(AbortSignal),
    );
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.secure-file-result",
      requestId,
      result: { ok: true, operation: "recover" },
    });
  });

  it("waits for secure-file shutdown before confirming runtime stop", async () => {
    let finishSecureFileShutdown: ((confirmed: boolean) => void) | undefined;
    const secureFileBroker: RuntimeSecureFileBroker = {
      perform: vi.fn<RuntimeSecureFileBroker["perform"]>(async () => ({
        ok: false,
        code: "unavailable",
        message: "unused",
      })),
      shutdown: vi.fn(() => new Promise<boolean>((resolve) => {
        finishSecureFileShutdown = resolve;
      })),
    };
    const { children, supervisor } = createHarness({ secureFileBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    let settled = false;
    const stopped = supervisor.stop().then((confirmed) => {
      settled = true;
      return confirmed;
    });
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(secureFileBroker.shutdown).toHaveBeenCalledOnce();

    finishSecureFileShutdown?.(true);
    await expect(stopped).resolves.toBe(true);
  });

  it("reports an unconfirmed secure-file shutdown", async () => {
    const secureFileBroker: RuntimeSecureFileBroker = {
      perform: vi.fn<RuntimeSecureFileBroker["perform"]>(async () => ({
        ok: false,
        code: "unavailable",
        message: "unused",
      })),
      shutdown: vi.fn(async () => false),
    };
    const { children, supervisor } = createHarness({ secureFileBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const stopped = supervisor.stop();
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    await expect(stopped).resolves.toBe(false);
  });

  it("brokers attachments only to the current generation and bounds stalled requests", async () => {
    let resolveAttachment:
      | ((value: typeof trustedAttachment | null) => void)
      | undefined;
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(() => new Promise<typeof trustedAttachment | null>((resolvePromise) => {
        resolveAttachment = resolvePromise;
      })),
      release: vi.fn(async () => true),
    };
    const { children, supervisor } = createHarness({
      attachmentBroker,
      attachmentRequestTimeoutMs: 25,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const requestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-request",
      requestId,
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.resolve).toHaveBeenCalledWith(
      attachmentId,
      attachmentHandoffId,
      expect.any(AbortSignal),
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.attachment-result",
      requestId,
      ok: false,
      code: "unavailable",
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);

    children[0].exit(1);
    resolveAttachment?.(trustedAttachment);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).not.toHaveBeenCalled();
    expect(children[0].messages).not.toContainEqual(expect.objectContaining({
      type: "runtime.attachment-result",
      attachment: trustedAttachment,
    }));
  });

  it("returns only the main-authorized attachment descriptor", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn(async () => true),
    };
    const { children, supervisor } = createHarness({ attachmentBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const requestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-request",
      requestId,
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.attachment-result",
      requestId,
      ok: true,
      attachment: trustedAttachment,
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    const relinquishRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-relinquish-request",
      requestId: relinquishRequestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.attachment-relinquish-result",
      requestId: relinquishRequestId,
      ok: true,
      relinquished: true,
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);
    expect(attachmentBroker.release).not.toHaveBeenCalled();

    children[0].message({
      type: "runtime.attachment-relinquish-request",
      requestId: relinquishRequestId,
      attachmentId,
    });
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.attachment-relinquish-result",
      requestId: relinquishRequestId,
      ok: false,
      code: "invalid",
      message: "The attachment request identifier was already used.",
    });

    const retryRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-request",
      requestId: retryRequestId,
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.attachment-result",
      requestId: retryRequestId,
      ok: true,
      attachment: trustedAttachment,
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    const releaseRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-release-request",
      requestId: releaseRequestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).toHaveBeenCalledTimes(1);
    expect(attachmentBroker.release).toHaveBeenCalledWith(
      attachmentId,
      expect.any(AbortSignal),
    );
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.attachment-release-result",
      requestId: releaseRequestId,
      ok: true,
      released: true,
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);

    children[0].message({
      type: "runtime.attachment-release-request",
      requestId: releaseRequestId,
      attachmentId,
    });
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.attachment-release-result",
      requestId: releaseRequestId,
      ok: false,
      code: "invalid",
      message: "The attachment request identifier was already used.",
    });
    expect(attachmentBroker.release).toHaveBeenCalledTimes(1);

    children[0].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).toHaveBeenCalledTimes(1);
  });

  it("counts same-capability claims and deletes only after the last claim releases", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn(async () => true),
    };
    const { children, supervisor } = createHarness({ attachmentBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    for (const requestId of [crypto.randomUUID(), crypto.randomUUID()]) {
      children[0].message({
        type: "runtime.attachment-request",
        requestId,
        attachmentId,
        handoffId: attachmentHandoffId,
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    const relinquishRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-relinquish-request",
      requestId: relinquishRequestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.attachment-relinquish-result",
      requestId: relinquishRequestId,
      ok: true,
      relinquished: true,
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);
    expect(attachmentBroker.release).not.toHaveBeenCalled();

    const releaseRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-release-request",
      requestId: releaseRequestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).toHaveBeenCalledTimes(1);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);
  });

  it("keeps zero-claim release non-destructive and reserves cleanup for recovery", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn(async () => true),
    };
    const { children, supervisor } = createHarness({ attachmentBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const releaseRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-release-request",
      requestId: releaseRequestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.attachment-release-result",
      requestId: releaseRequestId,
      ok: true,
      released: false,
    });
    expect(attachmentBroker.release).not.toHaveBeenCalled();

    const cleanupRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-cleanup-request",
      requestId: cleanupRequestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).toHaveBeenCalledTimes(1);
    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.attachment-release-result",
      requestId: cleanupRequestId,
      ok: true,
      released: true,
    });
  });

  it("honors renderer deletion deferred during a late resolve result", async () => {
    let finishResolve!: (attachment: typeof trustedAttachment) => void;
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(() =>
        new Promise<typeof trustedAttachment | null>((resolveAttachment) => {
        finishResolve = resolveAttachment;
        })),
      release: vi.fn(async () => true),
    };
    const { children, supervisor } = createHarness({ attachmentBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const requestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-request",
      requestId,
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.deferAttachmentRelease(attachmentId)).toBe(true);

    finishResolve(trustedAttachment);
    await vi.advanceTimersByTimeAsync(0);
    const relinquishRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-relinquish-request",
      requestId: relinquishRequestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(attachmentBroker.release).toHaveBeenCalledTimes(1);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);
  });

  it("retains startup attachments when forced tree cleanup lacks runtime authority", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn(async () => true),
    };
    const { children, supervisor } = createHarness({ attachmentBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({
      type: "runtime.attachment-request",
      requestId: crypto.randomUUID(),
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).not.toHaveBeenCalled();

    children[0].message({
      type: "runtime.startup-failed",
      message: "The database is locked.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(attachmentBroker.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).not.toHaveBeenCalled();
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);
  });

  it("drops generation ownership when release confirms the capability is already absent", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn(async () => false),
    };
    const { children, supervisor } = createHarness({ attachmentBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].message({
      type: "runtime.attachment-request",
      requestId: crypto.randomUUID(),
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    const requestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-release-request",
      requestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.attachment-release-result",
      requestId,
      ok: true,
      released: false,
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);
  });

  it("retries retained attachment deletion after exact crash cleanup", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn()
        .mockRejectedValueOnce(new Error("attachment file is locked"))
        .mockResolvedValueOnce(true),
    };
    const { children, supervisor } = createHarness({ attachmentBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].message({
      type: "runtime.attachment-request",
      requestId: crypto.randomUUID(),
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);

    const requestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.attachment-release-request",
      requestId,
      attachmentId,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(children[0].messages.at(-1)).toMatchObject({
      type: "runtime.attachment-release-result",
      requestId,
      ok: false,
      code: "unavailable",
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).toHaveBeenCalledTimes(2);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);
  });

  it("keeps runtime-owned attachments until graceful shutdown settles", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn(async () => true),
    };
    const { children, supervisor } = createHarness({ attachmentBroker });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].message({
      type: "runtime.attachment-request",
      requestId: crypto.randomUUID(),
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    const stopped = supervisor.stop();
    expect(attachmentBroker.release).not.toHaveBeenCalled();
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    children[0].message({ type: "runtime.stopped" });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).not.toHaveBeenCalled();
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    children[0].exit(0);
    await expect(stopped).resolves.toBe(true);
    expect(attachmentBroker.release).toHaveBeenCalledWith(attachmentId);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);
  });

  it("correlates authoritative project-path resolutions and rejects them on worker exit", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const resolved = supervisor.resolveProjectPath(projectPathRequest);
    const resolveCommand = children[0].messages.at(-1);
    expect(resolveCommand).toMatchObject({
      type: "runtime.resolve-project-path",
      request: projectPathRequest,
    });
    if (resolveCommand?.type !== "runtime.resolve-project-path") throw new Error("Missing project path command");
    const canonical = resolve(workspaceDirectory, "src/index.ts");
    children[0].message({
      type: "runtime.project-path-resolved",
      requestId: resolveCommand.requestId,
      path: canonical,
    });
    await expect(resolved).resolves.toBe(canonical);

    const interrupted = supervisor.resolveProjectPath(projectPathRequest);
    children[0].exit(9);
    await expect(interrupted).rejects.toThrow("stopped before the project path was resolved");
  });

  it("correlates, times out, and rejects Private Connect requests across runtime generations", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const subject = {
      deviceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      scopes: ["view" as const],
      projectIds: [projectPathRequest.projectId],
      grants: privateConnectRuntimeGrantsFromProjectIds([projectPathRequest.projectId]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const request = {
      type: "state.get" as const,
      requestId: crypto.randomUUID(),
    };
    const resolved = supervisor.privateConnectRequest(subject, request);
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.private-connect-request",
      requestId: request.requestId,
      subject,
      request,
    });
    children[0].message({
      type: "runtime.private-connect-response",
      requestId: request.requestId,
      response: {
        type: "response",
        requestId: request.requestId,
        ok: false,
        code: "unavailable",
        message: "Not ready.",
      },
    });
    await expect(resolved).resolves.toMatchObject({
      requestId: request.requestId,
      ok: false,
    });

    const prompt = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId: projectPathRequest.projectId,
      content: "Prepare then commit",
    };
    const promptingSubject = {
      ...subject,
      scopes: ["view" as const, "prompt" as const],
    };
    const prepared = supervisor.preparePrivateConnectPrompt(
      promptingSubject,
      prompt,
    );
    const prepareCommand = children[0].messages.at(-1);
    expect(prepareCommand).toMatchObject({
      type: "runtime.private-connect-prompt-prepare",
      subject: promptingSubject,
      request: prompt,
    });
    if (prepareCommand?.type !== "runtime.private-connect-prompt-prepare") {
      throw new Error("Missing prompt preparation command");
    }
    children[0].message({
      type: "runtime.private-connect-prompt-result",
      operationId: prepareCommand.operationId,
      requestId: prompt.requestId,
      phase: "prepare",
      preparationId: "33333333-3333-4333-8333-333333333333",
      response: null,
    });
    await expect(prepared).resolves.toEqual({
      preparationId: "33333333-3333-4333-8333-333333333333",
    });

    const commitPosted = vi.fn();
    const committed = supervisor.commitPrivateConnectPrompt(
      promptingSubject,
      prompt,
      "33333333-3333-4333-8333-333333333333",
      commitPosted,
    );
    expect(commitPosted).toHaveBeenCalledOnce();
    const commitCommand = children[0].messages.at(-1);
    expect(commitCommand).toMatchObject({
      type: "runtime.private-connect-prompt-commit",
      subject: promptingSubject,
      request: prompt,
    });
    if (commitCommand?.type !== "runtime.private-connect-prompt-commit") {
      throw new Error("Missing prompt commit command");
    }
    children[0].message({
      type: "runtime.private-connect-prompt-result",
      operationId: commitCommand.operationId,
      requestId: prompt.requestId,
      phase: "commit",
      preparationId: null,
      response: {
        type: "response",
        requestId: prompt.requestId,
        ok: true,
        result: {
          kind: "prompt.accepted",
          deliveryId: prompt.deliveryId,
          turnId: crypto.randomUUID(),
        },
      },
    });
    await expect(committed).resolves.toMatchObject({ ok: true });

    const timedRequest = {
      ...request,
      requestId: crypto.randomUUID(),
    };
    const timed = supervisor.privateConnectRequest(subject, timedRequest);
    const timedRejection = expect(timed).rejects.toThrow(
      "Private Connect request timed out",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await timedRejection;

    const interrupted = supervisor.privateConnectRequest(subject, {
      ...request,
      requestId: crypto.randomUUID(),
    });
    children[0].exit(9);
    await expect(interrupted).rejects.toThrow(
      "stopped before the Private Connect request completed",
    );
  });

  it("does not report a commit as posted after the runtime becomes unavailable", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const subject = {
      deviceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      scopes: ["view" as const, "prompt" as const],
      projectIds: [projectPathRequest.projectId],
      grants: privateConnectRuntimeGrantsFromProjectIds([projectPathRequest.projectId]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const request = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId: projectPathRequest.projectId,
      content: "Do not post after runtime shutdown",
    };
    const stopped = supervisor.stop();
    const messagesBeforeCommit = children[0].messages.length;
    const commitPosted = vi.fn();

    await expect(supervisor.commitPrivateConnectPrompt(
      subject,
      request,
      crypto.randomUUID(),
      commitPosted,
    )).rejects.toThrow("local service is starting");
    expect(commitPosted).not.toHaveBeenCalled();
    expect(children[0].messages).toHaveLength(messagesBeforeCommit);

    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    await expect(stopped).resolves.toBe(true);
  });

  it("does not report a commit as posted when utility delivery throws", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].postError = new Error("utility port closed");
    const commitPosted = vi.fn();

    await expect(supervisor.commitPrivateConnectPrompt(
      {
        deviceId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        scopes: ["view", "prompt"],
        projectIds: [projectPathRequest.projectId],
        grants: privateConnectRuntimeGrantsFromProjectIds([projectPathRequest.projectId]),
        grantVersion: 1,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      {
        type: "prompt.send",
        requestId: crypto.randomUUID(),
        deliveryId: crypto.randomUUID(),
        conversationId: projectPathRequest.projectId,
        content: "Do not classify a thrown post as delivery",
      },
      crypto.randomUUID(),
      commitPosted,
    )).rejects.toThrow("could not be posted");
    expect(commitPosted).not.toHaveBeenCalled();
    expect(children[0].killCalls).toBe(0);
  });

  it("reports startup failure and retries only after forced cleanup and exit", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.startup-failed", message: "The database is locked." });

    expect(() => supervisor.connection()).toThrow("The database is locked");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(1);

    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.snapshot()).toMatchObject({ phase: "restarting", restartAttempt: 1, restartScheduled: true });
    await vi.advanceTimersByTimeAsync(499);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
  });

  it("forces a startup-failed child to exit when its own cleanup stalls", async () => {
    const { children, forceKill, supervisor } = createHarness({
      shutdownGraceMs: 100,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({
      type: "runtime.startup-failed",
      message: "Startup cleanup is stalled.",
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(forceKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));

    children[0].exit(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(children).toHaveLength(2);
  });

  it("rotates the capability URL after an unexpected crash without duplicating a live child", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].exit(9);
    children[0].exit(9);

    vi.advanceTimersByTime(500);
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
    children[1].message({ type: "runtime.ready", websocketUrl: secondUrl });
    expect(supervisor.connection()).toEqual({ websocketUrl: secondUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 2 });
  });

  it("restarts outside safety mode after exact owned crash cleanup", async () => {
    const recoverOwnedProcesses = vi.fn(async () => true);
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    children[0].exit(9);
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

  it("waits for the crashed generation store helper before restarting", async () => {
    let rejectResult!: (error: Error) => void;
    let resolveStopped!: () => void;
    let observedSignal: AbortSignal | undefined;
    const runner = vi.fn((
      _operation: unknown,
      signal?: AbortSignal,
    ) => {
      observedSignal = signal;
      const result = new Promise<void>((_resolve, reject) => {
        rejectResult = reject;
      });
      signal?.addEventListener("abort", () => {
        rejectResult(new Error("cancelled"));
      }, { once: true });
      const stopped = new Promise<void>((resolveStoppedPromise) => {
        resolveStopped = resolveStoppedPromise;
      });
      return { result, stopped, ready: Promise.resolve(false) };
    });
    const secureFileBroker: RuntimeSecureFileBroker = {
      perform: vi.fn<RuntimeSecureFileBroker["perform"]>(async () => ({
        ok: false,
        code: "unavailable",
        message: "unused",
      })),
    };
    const { children, supervisor } = createHarness({
      conversationAttachmentStoreRunner: runner as never,
      conversationAttachmentStoreAuthority,
      secureFileBroker,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].message({
      type: "runtime.conversation-attachment-store-request",
      requestId: crypto.randomUUID(),
      encodedOperation: encodeConversationAttachmentStoreOperation({
        operation: "remove",
        root: conversationAttachmentStoreAuthority.root,
        rootDev: conversationAttachmentStoreAuthority.dev,
        rootIno: conversationAttachmentStoreAuthority.ino,
        rootUid: conversationAttachmentStoreAuthority.uid,
        name: crypto.randomUUID(),
      }),
    });
    expect(runner).toHaveBeenCalledOnce();

    children[0].exit(9);
    expect(() => supervisor.connection()).toThrow("local service is starting");
    expect(supervisor.snapshot()).toMatchObject({
      phase: "restarting",
      websocketUrl: null,
      restartScheduled: false,
    });
    const lateSecureFileRequestId = crypto.randomUUID();
    children[0].message({
      type: "runtime.secure-file-request",
      requestId: lateSecureFileRequestId,
      operation: "read",
      root: workspaceDirectory,
      rootIdentity: { dev: "1", ino: "2" },
      parentIdentities: [],
      targetIdentity: { dev: "1", ino: "3" },
      path: "README.md",
      maxBytes: 1024,
    });
    expect(secureFileBroker.perform).not.toHaveBeenCalled();
    expect(children[0].messages.at(-1)).toEqual({
      type: "runtime.secure-file-result",
      requestId: lateSecureFileRequestId,
      result: {
        ok: false,
        code: "unavailable",
        message: "The secure file service is unavailable.",
      },
    });
    await vi.advanceTimersByTimeAsync(runtimeRestartDelayMs(0));
    expect(observedSignal?.aborted).toBe(true);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot().restartScheduled).toBe(false);

    resolveStopped();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.snapshot().restartScheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(runtimeRestartDelayMs(0));
    expect(children).toHaveLength(2);
  });

  it("blocks restart when a crashed generation store helper exit is unconfirmed", async () => {
    let rejectResult!: (error: Error) => void;
    let rejectStopped!: (error: Error) => void;
    const runner = vi.fn((
      _operation: unknown,
      signal?: AbortSignal,
    ) => {
      const result = new Promise<void>((_resolve, reject) => {
        rejectResult = reject;
      });
      signal?.addEventListener("abort", () => {
        rejectResult(new Error("cancelled"));
      }, { once: true });
      const stopped = new Promise<void>((_resolve, reject) => {
        rejectStopped = reject;
      });
      return { result, stopped, ready: Promise.resolve(false) };
    });
    const { children, supervisor } = createHarness({
      conversationAttachmentStoreRunner: runner as never,
      conversationAttachmentStoreAuthority,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].message({
      type: "runtime.conversation-attachment-store-request",
      requestId: crypto.randomUUID(),
      encodedOperation: encodeConversationAttachmentStoreOperation({
        operation: "remove",
        root: conversationAttachmentStoreAuthority.root,
        rootDev: conversationAttachmentStoreAuthority.dev,
        rootIno: conversationAttachmentStoreAuthority.ino,
        rootUid: conversationAttachmentStoreAuthority.uid,
        name: crypto.randomUUID(),
      }),
    });

    children[0].exit(9);
    rejectStopped(new Error("utility exit unconfirmed"));
    await vi.advanceTimersByTimeAsync(runtimeRestartDelayMs(0) * 2);

    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      restartScheduled: false,
      lastError: "Conversation attachment storage shutdown could not be confirmed.",
    });
    supervisor.start();
    expect(children).toHaveLength(1);
  });

  it("recycles through trusted shutdown and waits for the exact replacement readiness", async () => {
    const secureFileBroker: RuntimeSecureFileBroker = {
      perform: vi.fn<RuntimeSecureFileBroker["perform"]>(async () => ({
        ok: false,
        code: "unavailable",
        message: "unused",
      })),
      shutdown: vi.fn(async () => true),
    };
    const { children, forceKill, supervisor } = createHarness({
      secureFileBroker,
    });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    expect(supervisor.testOnlyRecycle()).toBe(recycled);
    expect(children[0].messages.at(-1)).toEqual({ type: "runtime.shutdown" });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "restarting",
      generation: 1,
      pid: 10_000,
      websocketUrl: null,
    });
    children[0].message({ type: "runtime.stopped" });
    expect(children[0].messages.at(-1)).toEqual({ type: "runtime.stopped-acknowledged" });
    children[0].exit(0);
    expect(children).toHaveLength(2);
    children[1].spawn();
    expect(children[1].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        runtimeGenerationId: expect.stringMatching(/:2$/u),
        confirmedTerminatedRuntimeGenerationIds: [
          expect.stringMatching(/:1$/u),
        ],
      },
    });
    children[1].message({ type: "runtime.ready", websocketUrl: secondUrl });

    await expect(recycled).resolves.toBe(true);
    expect(forceKill).not.toHaveBeenCalled();
    expect(secureFileBroker.shutdown).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "ready",
      generation: 2,
      pid: 10_001,
      websocketUrl: secondUrl,
      lastError: null,
    });
  });

  it("rejects an unconfirmed recycle without admitting a replacement", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const rejected = expect(recycled).rejects.toThrow(/complete process cleanup/u);
    children[0].message({ type: "runtime.shutdown-unconfirmed" });
    await rejected;
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 1,
      pid: null,
      restartScheduled: false,
    });
  });

  it("rejects a source exit before trusted stopped without a replacement", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const rejected = expect(recycled).rejects.toThrow(/clean readiness/u);
    children[0].exit(9);
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 1,
      restartScheduled: false,
    });
  });

  it("rejects replacement startup failure without a second replacement", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const rejected = expect(recycled).rejects.toThrow("Replacement failed");
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    children[1].spawn();
    children[1].message({
      type: "runtime.startup-failed",
      message: "Replacement failed",
    });
    await rejected;
    children[1].exit(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(2);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 2,
      restartScheduled: false,
    });
  });

  it("rejects replacement exit before readiness without another replacement", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const rejected = expect(recycled).rejects.toThrow(/clean readiness/u);
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    children[1].spawn();
    children[1].exit(9);
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(2);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 2,
      restartScheduled: false,
    });
  });

  it("retains the source when cleanup receipt publication fails", async () => {
    const publish = vi.spyOn(
      RuntimeCleanupReceiptJournal.prototype,
      "publish",
    ).mockReturnValue(false);
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const rejected = expect(recycled).rejects.toThrow(/receipt/u);
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    await rejected;
    publish.mockRestore();

    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 1,
      restartScheduled: false,
    });
  });

  it("rejects when a trusted stopped worker cannot be terminated", async () => {
    let resolveForceKill!: (confirmed: boolean) => void;
    const { children, forceKill, supervisor } = createHarness();
    forceKill.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveForceKill = resolve;
    }));
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const rejected = expect(recycled).rejects.toThrow(
      /shutdown deadline|process tree/u,
    );
    children[0].message({ type: "runtime.stopped" });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    children[0].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    resolveForceKill(false);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 1,
      restartScheduled: false,
    });
  });

  it("fails closed when a clean recycle misses its bounded shutdown deadline", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const rejected = expect(recycled).rejects.toThrow(/shutdown deadline/u);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      pid: null,
      restartScheduled: false,
    });
  });

  it.each(["before", "after"] as const)(
    "rejects trusted stopped %s a failed fallback once grace elapsed",
    async (stoppedOrder) => {
      let resolveForceKill!: (confirmed: boolean) => void;
      const cleanupReceiptPublish = vi.spyOn(
        RuntimeCleanupReceiptJournal.prototype,
        "publish",
      );
      const attachmentBroker: RuntimeAttachmentBroker = {
        resolve: vi.fn(async () => trustedAttachment),
        release: vi.fn(async () => true),
      };
      const { children, forceKill, supervisor } = createHarness({
        attachmentBroker,
      });
      forceKill.mockImplementation(() => new Promise<boolean>((resolve) => {
        resolveForceKill = resolve;
      }));
      supervisor.start();
      children[0].spawn();
      children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
      children[0].message({
        type: "runtime.attachment-request",
        requestId: crypto.randomUUID(),
        attachmentId,
        handoffId: attachmentHandoffId,
      });
      await vi.advanceTimersByTimeAsync(0);

      const recycled = supervisor.testOnlyRecycle();
      const rejected = expect(recycled).rejects.toThrow(/process tree/u);
      if (stoppedOrder === "before") {
        children[0].message({ type: "runtime.stopped" });
      }
      await vi.advanceTimersByTimeAsync(1_000);
      resolveForceKill(false);
      await vi.advanceTimersByTimeAsync(0);
      if (stoppedOrder === "after") {
        children[0].message({ type: "runtime.stopped" });
      }
      children[0].exit(0);
      await rejected;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(cleanupReceiptPublish).not.toHaveBeenCalled();
      expect(attachmentBroker.release).not.toHaveBeenCalled();
      expect(supervisor.ownsAttachment(attachmentId)).toBe(true);
      expect(children).toHaveLength(1);
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        generation: 1,
        pid: null,
      });
      cleanupReceiptPublish.mockRestore();
    },
  );

  it("accepts trusted stopped after grace when forced cleanup succeeds", async () => {
    let resolveForceKill!: (confirmed: boolean) => void;
    const cleanupReceiptPublish = vi.spyOn(
      RuntimeCleanupReceiptJournal.prototype,
      "publish",
    );
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn(async () => true),
    };
    const { children, forceKill, supervisor } = createHarness({
      attachmentBroker,
    });
    forceKill.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveForceKill = resolve;
    }));
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].message({
      type: "runtime.attachment-request",
      requestId: crypto.randomUUID(),
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);

    const recycled = supervisor.testOnlyRecycle();
    await vi.advanceTimersByTimeAsync(1_000);
    children[0].message({ type: "runtime.stopped" });
    expect(cleanupReceiptPublish).not.toHaveBeenCalled();
    expect(attachmentBroker.release).not.toHaveBeenCalled();
    children[0].exit(0);
    resolveForceKill(true);
    await vi.advanceTimersByTimeAsync(0);
    children[1].spawn();
    children[1].message({ type: "runtime.ready", websocketUrl: secondUrl });

    await expect(recycled).resolves.toBe(true);
    expect(cleanupReceiptPublish).toHaveBeenCalledOnce();
    expect(attachmentBroker.release).toHaveBeenCalledWith(attachmentId);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);
    expect(children).toHaveLength(2);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "ready",
      generation: 2,
      pid: 10_001,
    });
    cleanupReceiptPublish.mockRestore();
  });

  it("lets application stop take over an in-flight clean recycle", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const stopped = supervisor.stop();
    await expect(recycled).rejects.toThrow(/application shutdown/u);
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);

    await expect(stopped).resolves.toBe(true);
    vi.runAllTimers();
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot().phase).toBe("stopped");
  });

  it("lets application stop take over while recycle termination is pending", async () => {
    let resolveForceKill!: (confirmed: boolean) => void;
    const { children, forceKill, supervisor } = createHarness();
    forceKill.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveForceKill = resolve;
    }));
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const recycled = supervisor.testOnlyRecycle();
    const rejected = expect(recycled).rejects.toThrow(/application shutdown/u);
    await vi.advanceTimersByTimeAsync(1_000);
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    const stopped = supervisor.stop();
    await rejected;
    resolveForceKill(true);
    await vi.advanceTimersByTimeAsync(0);

    await expect(stopped).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 1,
      pid: null,
      restartScheduled: false,
    });
  });

  it("bounds crash-and-reconnect attempts and quarantines prior generations", () => {
    const crashCount = 3;
    const { children, supervisor } = createHarness({
      stableUptimeMs: 60_000,
      recoverOwnedProcesses: () => null,
    });
    supervisor.start();

    for (let cycle = 0; cycle < crashCount; cycle += 1) {
      const child = children[cycle];
      expect(child).toBeDefined();
      child!.spawn();
      child!.message({
        type: "runtime.ready",
        websocketUrl: `ws://127.0.0.1:${41_100 + cycle}/runtime/${cycle % 2 === 0 ? "a".repeat(43) : "b".repeat(43)}`,
      });
      expect(supervisor.snapshot()).toMatchObject({
        phase: "ready",
        generation: cycle + 1,
        pid: 10_000 + cycle,
      });
      child!.exit(9);
      expect(supervisor.snapshot()).toMatchObject(cycle < 2 ? {
        phase: "restarting",
        generation: cycle + 1,
        pid: null,
        restartScheduled: true,
      } : {
        phase: "stopped",
        generation: cycle + 1,
        pid: null,
        restartScheduled: false,
      });
      if (cycle === 2) break;
      vi.advanceTimersByTime(runtimeRestartDelayMs(cycle));
      expect(children).toHaveLength(cycle + 2);
    }
    expect(children).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses bounded exponential backoff and resets it only after stable readiness", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(runtimeRestartDelayMs)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    const { children, supervisor } = createHarness({ stableUptimeMs: 2_000 });
    supervisor.start();
    children[0].spawn();
    children[0].exit(1);
    vi.advanceTimersByTime(500);
    children[1].spawn();
    children[1].message({ type: "runtime.ready", websocketUrl: firstUrl });
    expect(supervisor.snapshot().restartAttempt).toBe(1);
    vi.advanceTimersByTime(1_999);
    expect(supervisor.snapshot().restartAttempt).toBe(1);
    vi.advanceTimersByTime(1);
    expect(supervisor.snapshot().restartAttempt).toBe(0);
  });

  it("kills a child that never becomes ready and waits for exit before replacing it", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(children[0].killCalls).toBe(0);
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));
    expect(children).toHaveLength(1);
    expect(() => supervisor.connection()).toThrow("did not become ready");
    children[0].exit(1);
    vi.advanceTimersByTime(500);
    expect(children).toHaveLength(2);
  });

  it("shuts down cleanly without restart and escalates only when grace expires", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const stopped = supervisor.stop();
    expect(children[0].messages.at(-1)).toEqual({ type: "runtime.shutdown" });
    children[0].exit(0);
    await stopped;
    vi.runAllTimers();
    expect(children).toHaveLength(1);
    expect(children[0].killCalls).toBe(0);
    expect(forceKill).not.toHaveBeenCalled();
    expect(supervisor.snapshot().phase).toBe("stopped");
  });

  it("owns the full shutdown deadline before posting to the worker", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    vi.spyOn(children[0], "postMessage").mockImplementationOnce(() => {
      throw new Error("worker port closed");
    });
    const shutdownDeadlineAt = Date.now() + 2_000;

    const stopped = supervisor.stop();

    expect(forceKill).toHaveBeenCalledWith(10_000, shutdownDeadlineAt);
    expect(forceKill).toHaveBeenCalledOnce();
    await Promise.resolve();
    children[0].exit(137);
    await expect(stopped).resolves.toBe(false);
  });

  it("executes the supervisor tree fallback while an unconfirmed runtime close keeps the worker alive", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    let settled = false;
    const stopped = supervisor.stop().then((confirmed) => {
      settled = true;
      return confirmed;
    });
    children[0].message({ type: "runtime.shutdown-unconfirmed" });

    expect(settled).toBe(false);
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));

    children[0].exit(137);
    await expect(stopped).resolves.toBe(false);
    vi.runAllTimers();
    expect(forceKill).toHaveBeenCalledOnce();
  });

  it("reuses an early tree fallback through grace and the final deadline", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const stopped = supervisor.stop();
    const shutdownDeadlineAt = Date.now() + 2_000;
    children[0].message({ type: "runtime.shutdown-unconfirmed" });
    await Promise.resolve();
    expect(forceKill).toHaveBeenCalledWith(10_000, shutdownDeadlineAt);
    expect(forceKill).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(forceKill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(stopped).resolves.toBe(false);
    expect(forceKill).toHaveBeenCalledOnce();

    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reports shutdown as unconfirmed when forced tree termination cannot be verified", async () => {
    const { children, forceKill, supervisor } = createHarness();
    forceKill.mockReturnValue(false);
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    const stopped = supervisor.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));
    expect(supervisor.snapshot().lastError).toBe(
      "The runtime process tree could not be confirmed stopped.",
    );

    children[0].exit(0);
    await expect(stopped).resolves.toBe(false);
    expect(supervisor.snapshot().phase).toBe("stopped");
  });

  it("allows the normal main quit only after the worker exits", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const quitMain = vi.fn();
    const stopped = supervisor.stop().then(quitMain);
    children[0].message({ type: "runtime.stopped" });
    await Promise.resolve();
    expect(quitMain).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopping", pid: 10_000, restartScheduled: false });
    children[0].exit(0);
    await stopped;
    expect(quitMain).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", pid: null, restartScheduled: false });
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });

  it("keeps one force-kill attempt within the responsive supervisor deadline", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
      release: vi.fn(async () => true),
    };
    const { children, forceKill, supervisor } = createHarness({
      attachmentBroker,
    });
    let resolveForceKill!: (confirmed: boolean) => void;
    forceKill.mockImplementation(() =>
      new Promise<boolean>((resolve) => {
        resolveForceKill = resolve;
      }));
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].message({
      type: "runtime.attachment-request",
      requestId: crypto.randomUUID(),
      attachmentId,
      handoffId: attachmentHandoffId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    let stopSettled = false;
    const stopped = supervisor.stop().then((confirmed) => {
      stopSettled = true;
      return confirmed;
    });
    const shutdownDeadlineAt = Date.now() + 2_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children[0].killCalls).toBe(0);
    expect(forceKill).toHaveBeenCalledWith(10_000, shutdownDeadlineAt);
    expect(forceKill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(forceKill).toHaveBeenCalledOnce();
    expect(stopSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopped).resolves.toBe(false);
    expect(forceKill).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopping",
      pid: 10_000,
      lastError: "The runtime process tree could not be confirmed stopped.",
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);
    expect(attachmentBroker.release).not.toHaveBeenCalled();

    resolveForceKill(false);
    await vi.advanceTimersByTimeAsync(0);
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      pid: null,
    });
    expect(attachmentBroker.release).not.toHaveBeenCalled();
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });

  it("cancels a pending restart on intentional shutdown", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].exit(1);
    expect(supervisor.snapshot().restartScheduled).toBe(true);
    await supervisor.stop();
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot().phase).toBe("stopped");
  });
});
