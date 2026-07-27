import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeSupervisor,
  runtimeRestartDelayMs,
  type RuntimeAttachmentBroker,
  type RuntimeCredentialBroker,
} from "../../src/main/runtime-supervisor";
import type { RuntimeWorkerCommand } from "../../src/main/runtime-process-protocol";

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
  attachmentBroker?: RuntimeAttachmentBroker;
  attachmentRequestTimeoutMs?: number;
} = {}) {
  const children: FakeUtilityProcess[] = [];
  const forceKill = vi.fn();
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

  it("brokers attachments only to the current generation and bounds stalled requests", async () => {
    let resolveAttachment:
      | ((value: typeof trustedAttachment | null) => void)
      | undefined;
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(() => new Promise<typeof trustedAttachment | null>((resolvePromise) => {
        resolveAttachment = resolvePromise;
      })),
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

    children[0].exit(1);
    resolveAttachment?.(trustedAttachment);
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0].messages).not.toContainEqual(expect.objectContaining({
      type: "runtime.attachment-result",
      attachment: trustedAttachment,
    }));
  });

  it("returns only the main-authorized attachment descriptor", async () => {
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn(async () => trustedAttachment),
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

  it("kills a child that never becomes ready and waits for exit before replacing it", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    vi.advanceTimersByTime(2_000);
    expect(children[0].killCalls).toBe(1);
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

  it("settles after forcing an unresponsive utility process and never starts a replacement", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const stopped = supervisor.stop();
    vi.advanceTimersByTime(1_000);
    expect(children[0].killCalls).toBe(1);
    vi.advanceTimersByTime(500);
    expect(forceKill).toHaveBeenCalledWith(10_000);
    vi.advanceTimersByTime(500);
    expect(forceKill).toHaveBeenCalledTimes(2);
    await stopped;
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", pid: null, lastError: expect.stringContaining("shutdown deadline") });
    children[0].exit(137);
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
