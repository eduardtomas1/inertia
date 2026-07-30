import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeSupervisor,
  runtimeRestartDelayMs,
  type RuntimeAttachmentBroker,
  type RuntimeCredentialBroker,
  type RuntimeSecureFileBroker,
} from "../../src/main/runtime-supervisor";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

const firstUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const secondUrl = `ws://127.0.0.1:41002/runtime/${"b".repeat(43)}`;
const dataDirectory = resolve(tmpdir(), "inertia data");
const workspaceDirectory = resolve(tmpdir(), "inertia workspace");
const attachmentId = "33333333-3333-4333-8333-333333333333";
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

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined;
  readonly messages: RuntimeWorkerCommand[] = [];
  killCalls = 0;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  postMessage(message: RuntimeWorkerCommand): void {
    this.messages.push(message);
  }

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  spawn(): void { this.emit("spawn"); }
  message(value: unknown): void { this.emit("message", value); }
  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

function createHarness(options: {
  stableUptimeMs?: number;
  shutdownGraceMs?: number;
  forceKillWaitMs?: number;
  credentialBroker?: RuntimeCredentialBroker;
  credentialRequestTimeoutMs?: number;
  secureFileBroker?: RuntimeSecureFileBroker;
  attachmentBroker?: RuntimeAttachmentBroker;
  attachmentRequestTimeoutMs?: number;
} = {}) {
  const children: FakeUtilityProcess[] = [];
  const forceKill = vi.fn((
    _pid: number,
    _deadlineAt: number,
  ): boolean | Promise<boolean> => true);
  const supervisor = new RuntimeSupervisor({
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
    credentialBroker: options.credentialBroker,
    credentialRequestTimeoutMs: options.credentialRequestTimeoutMs,
    secureFileBroker: options.secureFileBroker,
    attachmentBroker: options.attachmentBroker,
    attachmentRequestTimeoutMs: options.attachmentRequestTimeoutMs,
  });
  return { children, forceKill, supervisor };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("RuntimeSupervisor", () => {
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
      },
    }]);
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.connection()).toEqual({ websocketUrl: firstUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 1, pid: 10_000 });
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
    });
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.resolve).toHaveBeenCalledWith(
      attachmentId,
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

  it("releases generation-owned attachments when runtime startup fails", async () => {
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
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).not.toHaveBeenCalled();

    children[0].message({
      type: "runtime.startup-failed",
      message: "The database is locked.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(attachmentBroker.release).toHaveBeenCalledTimes(1);
    expect(attachmentBroker.release).toHaveBeenCalledWith(attachmentId);
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

  it("retains generation ownership when attachment deletion fails", async () => {
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
    expect(attachmentBroker.release).toHaveBeenLastCalledWith(attachmentId);
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
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    const stopped = supervisor.stop();
    expect(attachmentBroker.release).not.toHaveBeenCalled();
    expect(supervisor.ownsAttachment(attachmentId)).toBe(true);

    children[0].message({ type: "runtime.stopped" });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachmentBroker.release).toHaveBeenCalledWith(attachmentId);
    expect(supervisor.ownsAttachment(attachmentId)).toBe(false);

    children[0].exit(0);
    await expect(stopped).resolves.toBe(true);
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

  it("reports startup failure and retries only after the failed child exits", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.startup-failed", message: "The database is locked." });

    expect(() => supervisor.connection()).toThrow("The database is locked");
    vi.advanceTimersByTime(10_000);
    expect(children).toHaveLength(1);

    children[0].exit(1);
    expect(supervisor.snapshot()).toMatchObject({ phase: "restarting", restartAttempt: 1, restartScheduled: true });
    vi.advanceTimersByTime(499);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
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
    children[1].message({ type: "runtime.ready", websocketUrl: secondUrl });
    expect(supervisor.connection()).toEqual({ websocketUrl: secondUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 2 });
  });

  it("survives a sustained crash-and-reconnect loop without leaking children or timers", () => {
    const crashCount = 64;
    const { children, supervisor } = createHarness({ stableUptimeMs: 60_000 });
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
      expect(supervisor.snapshot()).toMatchObject({
        phase: "restarting",
        generation: cycle + 1,
        pid: null,
        restartScheduled: true,
      });
      vi.advanceTimersByTime(runtimeRestartDelayMs(cycle));
      expect(children).toHaveLength(cycle + 2);
    }

    const recovered = children[crashCount]!;
    recovered.spawn();
    recovered.message({ type: "runtime.ready", websocketUrl: secondUrl });
    expect(supervisor.connection()).toEqual({ websocketUrl: secondUrl });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "ready",
      generation: crashCount + 1,
      pid: 10_000 + crashCount,
      restartScheduled: false,
    });
    expect(vi.getTimerCount()).toBe(1);
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
    await expect(stopped).resolves.toBe(true);
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
    await expect(stopped).resolves.toBe(true);
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
    expect(attachmentBroker.release).toHaveBeenCalledWith(attachmentId);
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
