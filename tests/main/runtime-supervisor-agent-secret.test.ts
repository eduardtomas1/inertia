import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AGENT_SECRET_DELIVERY_TIMEOUT_MS, type RuntimeAgentSecretDeliveryOutcome } from "../../src/main/runtime-agent-secret-coordinator";
import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { parseRuntimeWorkerCommand, type RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

const readyUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const SECRET = "tskey-auth-kQ7xZ9pL2mN4";
const EXPIRES_AT = "2026-10-30T10:00:00.000Z";
let dataDirectory: string;

const armProcessContainment = () => process.platform === "win32"
  ? { kind: "windows-job-v1" as const, name: `Global\\InertiaRuntime-${"a".repeat(64)}` }
  : null;

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 12_345;
  readonly messages: RuntimeWorkerCommand[] = [];

  postMessage(message: RuntimeWorkerCommand): void {
    this.messages.push(structuredClone(message));
  }

  kill(): boolean {
    return true;
  }

  spawn(): void {
    this.emit("spawn");
  }

  message(value: unknown): void {
    const start = this.messages.findLast((message) => message.type === "runtime.start");
    if ((value as { type?: unknown }).type === "runtime.ready" && start?.type === "runtime.start") {
      for (const receiptRuntimeGenerationId of start.options.confirmedTerminatedRuntimeGenerationIds ?? []) {
        this.emit("message", {
          type: "runtime.cleanup-receipt-consumed",
          receiptRuntimeGenerationId,
          currentRuntimeGenerationId: start.options.runtimeGenerationId,
        });
      }
    }
    this.emit("message", value);
  }

  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

interface FakeAgentSecretVault {
  ids: string[];
  forgotten: string[];
  failForget: Set<string>;
  requestIds: Mock<() => Promise<string[]>>;
}

function fakeVault(ids: string[]): FakeAgentSecretVault {
  const vault: FakeAgentSecretVault = {
    ids,
    forgotten: [],
    failForget: new Set(),
    requestIds: vi.fn<() => Promise<string[]>>(async () => [...vault.ids]),
  };
  return vault;
}

function supervisorWith(children: FakeUtilityProcess[], vault?: FakeAgentSecretVault): RuntimeSupervisor {
  return new RuntimeSupervisor({
    ...(vault ? {
      credentialBroker: {
        resolve: async () => null,
        status: async () => ({ hasSecret: false, credentialGeneration: null }),
        clear: async () => false,
        forget: async () => {
          throw new Error("backend credentials are never forgotten by reconciliation");
        },
        agentSecrets: {
          requestIds: vault.requestIds,
          forget: async (requestId: string) => {
            if (vault.failForget.has(requestId)) throw new Error("vault write failed");
            vault.forgotten.push(requestId);
            vault.ids = vault.ids.filter((id) => id !== requestId);
            return true;
          },
        },
      },
    } : {}),
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
    workerOptions: { dataDirectory, defaultWorkspacePath: dataDirectory, enableProviders: false },
    spawn: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child as never;
    },
    recoverOwnedProcesses: () => true,
    armProcessContainment,
  });
}

function readySupervisor(vault?: FakeAgentSecretVault): { supervisor: RuntimeSupervisor; children: FakeUtilityProcess[] } {
  const children: FakeUtilityProcess[] = [];
  const supervisor = supervisorWith(children, vault);
  supervisor.start();
  children[0]!.spawn();
  children[0]!.message({ type: "runtime.ready", websocketUrl: readyUrl });
  return { supervisor, children };
}

function delivery(overrides: Partial<{ conversationId: string; requestId: string; vaulted: boolean }> = {}) {
  return { conversationId: randomUUID(), requestId: randomUUID(), secret: SECRET, vaulted: true, ...overrides };
}

function deliverCommands(child: FakeUtilityProcess) {
  return child.messages.filter((message): message is Extract<RuntimeWorkerCommand, { type: "runtime.agent-secret-deliver" }> =>
    message.type === "runtime.agent-secret-deliver");
}

function lastDeliverCommand(child: FakeUtilityProcess) {
  const command = deliverCommands(child).at(-1);
  if (!command) throw new Error("Missing agent secret delivery command");
  return command;
}

function reconcileCommands(child: FakeUtilityProcess) {
  return child.messages.filter((message): message is Extract<RuntimeWorkerCommand, { type: "runtime.agent-secret-reconcile" }> =>
    message.type === "runtime.agent-secret-reconcile");
}

function settledState(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-agent-secret-supervisor-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("RuntimeSupervisor agent secret delivery", () => {
  it("is unavailable before the runtime is ready and posts nothing", async () => {
    const children: FakeUtilityProcess[] = [];
    const supervisor = supervisorWith(children);
    await expect(supervisor.deliverAgentSecret(delivery())).resolves.toEqual({ status: "rejected", reason: "unavailable" });
  });

  it("posts exactly the protocol command and resolves on the matching delivered event", async () => {
    const { supervisor, children } = readySupervisor();
    const input = delivery({ vaulted: false });
    const outcome = supervisor.deliverAgentSecret(input);
    const command = lastDeliverCommand(children[0]!);
    expect(command).toEqual({ type: "runtime.agent-secret-deliver", transportId: expect.any(String), ...input });
    expect(parseRuntimeWorkerCommand(command)).toEqual(command);
    expect(command.transportId).not.toBe(input.requestId);
    expect(Object.entries(command).filter(([, value]) => String(value).includes(SECRET)).map(([key]) => key)).toEqual(["secret"]);
    children[0]!.message({ type: "runtime.agent-secret-delivered", transportId: command.transportId, expiresAt: EXPIRES_AT, storage: "memory" });
    const result = await outcome;
    expect(result).toEqual({ status: "delivered", expiresAt: EXPIRES_AT, storage: "memory" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("correlates concurrent deliveries by transport id", async () => {
    const { supervisor, children } = readySupervisor();
    const first = supervisor.deliverAgentSecret(delivery());
    const firstCommand = lastDeliverCommand(children[0]!);
    const second = supervisor.deliverAgentSecret(delivery());
    const secondCommand = lastDeliverCommand(children[0]!);
    children[0]!.message({ type: "runtime.agent-secret-rejected", transportId: secondCommand.transportId, reason: "limit" });
    children[0]!.message({ type: "runtime.agent-secret-delivered", transportId: firstCommand.transportId, expiresAt: EXPIRES_AT, storage: "keychain" });
    await expect(first).resolves.toEqual({ status: "delivered", expiresAt: EXPIRES_AT, storage: "keychain" });
    await expect(second).resolves.toEqual({ status: "rejected", reason: "limit" });
  });

  it("refuses a second delivery for a request that is still in flight", async () => {
    const { supervisor, children } = readySupervisor();
    const input = delivery();
    const first = supervisor.deliverAgentSecret(input);
    await expect(supervisor.deliverAgentSecret(input)).resolves.toEqual({ status: "rejected", reason: "not-pending" });
    expect(deliverCommands(children[0]!)).toHaveLength(1);
    children[0]!.message({ type: "runtime.agent-secret-rejected", transportId: lastDeliverCommand(children[0]!).transportId, reason: "file-failed" });
    await expect(first).resolves.toEqual({ status: "rejected", reason: "file-failed" });
  });

  it("ignores unknown transport ids and treats a timeout as unavailable, ignoring a late answer", async () => {
    const { supervisor, children } = readySupervisor();
    const outcome = supervisor.deliverAgentSecret(delivery());
    const settled = settledState(outcome);
    const { transportId } = lastDeliverCommand(children[0]!);
    children[0]!.message({ type: "runtime.agent-secret-delivered", transportId: randomUUID(), expiresAt: EXPIRES_AT, storage: "keychain" });
    await vi.advanceTimersByTimeAsync(AGENT_SECRET_DELIVERY_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({ status: "rejected", reason: "unavailable" });
    children[0]!.message({ type: "runtime.agent-secret-delivered", transportId, expiresAt: EXPIRES_AT, storage: "keychain" });
    expect(supervisor.snapshot().phase).toBe("ready");
  });

  it("settles pending deliveries as unavailable when the worker exits and ignores the stale worker afterwards", async () => {
    const { supervisor, children } = readySupervisor();
    const stale = supervisor.deliverAgentSecret(delivery());
    const staleTransport = lastDeliverCommand(children[0]!).transportId;
    children[0]!.exit(9);
    await expect(stale).resolves.toEqual({ status: "rejected", reason: "unavailable" });

    await vi.advanceTimersByTimeAsync(60_000);
    const replacement = children[1];
    if (!replacement) throw new Error("The runtime did not restart");
    replacement.spawn();
    replacement.message({ type: "runtime.ready", websocketUrl: readyUrl });
    const current = supervisor.deliverAgentSecret(delivery());
    const currentTransport = lastDeliverCommand(replacement).transportId;
    const settled = settledState(current);
    children[0]!.message({ type: "runtime.agent-secret-delivered", transportId: currentTransport, expiresAt: EXPIRES_AT, storage: "keychain" });
    replacement.message({ type: "runtime.agent-secret-delivered", transportId: staleTransport, expiresAt: EXPIRES_AT, storage: "keychain" });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled()).toBe(false);
    replacement.message({ type: "runtime.agent-secret-rejected", transportId: currentTransport, reason: "ended" });
    await expect(current).resolves.toEqual<RuntimeAgentSecretDeliveryOutcome>({ status: "rejected", reason: "ended" });
  });

  it("treats an event carrying anything beyond the protocol fields as a broken worker", async () => {
    const { supervisor, children } = readySupervisor();
    const outcome = supervisor.deliverAgentSecret(delivery());
    const { transportId } = lastDeliverCommand(children[0]!);
    children[0]!.message({ type: "runtime.agent-secret-delivered", transportId, expiresAt: EXPIRES_AT, storage: "keychain", secret: SECRET });
    expect(supervisor.snapshot().lastError).toBe("The runtime process sent an invalid lifecycle message.");
    expect(JSON.stringify(supervisor.snapshot())).not.toContain(SECRET);
    children[0]!.exit(9);
    await expect(outcome).resolves.toEqual({ status: "rejected", reason: "unavailable" });
  });
});

describe("RuntimeSupervisor agent secret keychain reconciliation", () => {
  it("asks the ready runtime about every stored copy and forgets only the ones it reports orphaned", async () => {
    const saved = randomUUID();
    const orphan = randomUUID();
    const pending = randomUUID();
    const vault = fakeVault([saved, orphan, pending]);
    const { children } = readySupervisor(vault);
    await vi.advanceTimersByTimeAsync(0);
    const [command, ...extra] = reconcileCommands(children[0]!);
    expect(extra).toEqual([]);
    expect(command).toEqual({ type: "runtime.agent-secret-reconcile", transportId: expect.any(String), requestIds: [saved, orphan, pending] });
    expect(parseRuntimeWorkerCommand(command)).toEqual(command);
    children[0]!.message({ type: "runtime.agent-secret-reconciled", transportId: command!.transportId, orphaned: [orphan, randomUUID()] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.forgotten).toEqual([orphan]);
    expect(vault.ids).toEqual([saved, pending]);
  });

  it("forgets nothing when the runtime does not answer in time and ignores the late answer", async () => {
    const orphan = randomUUID();
    const vault = fakeVault([orphan]);
    const { supervisor, children } = readySupervisor(vault);
    await vi.advanceTimersByTimeAsync(0);
    const { transportId } = reconcileCommands(children[0]!)[0]!;
    await vi.advanceTimersByTimeAsync(AGENT_SECRET_DELIVERY_TIMEOUT_MS);
    children[0]!.message({ type: "runtime.agent-secret-reconciled", transportId, orphaned: [orphan] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.forgotten).toEqual([]);
    expect(supervisor.snapshot().phase).toBe("ready");
  });

  it("drops a reconciliation when the worker exits and reconciles again against the next runtime only", async () => {
    const orphan = randomUUID();
    const vault = fakeVault([orphan]);
    const { children } = readySupervisor(vault);
    await vi.advanceTimersByTimeAsync(0);
    const stale = reconcileCommands(children[0]!)[0]!;
    children[0]!.exit(9);
    await vi.advanceTimersByTimeAsync(60_000);
    const replacement = children[1]!;
    replacement.spawn();
    replacement.message({ type: "runtime.ready", websocketUrl: readyUrl });
    await vi.advanceTimersByTimeAsync(0);
    const current = reconcileCommands(replacement)[0]!;
    expect(current.transportId).not.toBe(stale.transportId);
    children[0]!.message({ type: "runtime.agent-secret-reconciled", transportId: current.transportId, orphaned: [orphan] });
    replacement.message({ type: "runtime.agent-secret-reconciled", transportId: stale.transportId, orphaned: [orphan] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.forgotten).toEqual([]);
    replacement.message({ type: "runtime.agent-secret-reconciled", transportId: current.transportId, orphaned: [orphan] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.forgotten).toEqual([orphan]);
  });

  it("keeps going past a failed forget and retries it at the next ready runtime", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const vault = fakeVault([first, second]);
    vault.failForget.add(first);
    const { children } = readySupervisor(vault);
    await vi.advanceTimersByTimeAsync(0);
    const command = reconcileCommands(children[0]!)[0]!;
    children[0]!.message({ type: "runtime.agent-secret-reconciled", transportId: command.transportId, orphaned: [first, second] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.forgotten).toEqual([second]);
    vault.failForget.clear();
    children[0]!.exit(9);
    await vi.advanceTimersByTimeAsync(60_000);
    children[1]!.spawn();
    children[1]!.message({ type: "runtime.ready", websocketUrl: readyUrl });
    await vi.advanceTimersByTimeAsync(0);
    const retry = reconcileCommands(children[1]!)[0]!;
    expect(retry.requestIds).toEqual([first]);
    children[1]!.message({ type: "runtime.agent-secret-reconciled", transportId: retry.transportId, orphaned: [first] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.forgotten).toEqual([second, first]);
  });

  it.each([
    ["holds no agent secret copy", () => fakeVault([])],
    ["cannot be read", () => {
      const vault = fakeVault([randomUUID()]);
      vault.requestIds.mockRejectedValue(new Error("vault corrupt"));
      return vault;
    }],
  ])("posts nothing when the keychain %s", async (_label, create) => {
    const vault = create();
    const { children } = readySupervisor(vault);
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.requestIds).toHaveBeenCalledTimes(1);
    expect(reconcileCommands(children[0]!)).toEqual([]);
    expect(vault.forgotten).toEqual([]);
  });
});

