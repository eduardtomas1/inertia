import { randomUUID } from "node:crypto";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerAgentSecretIpc,
  type AgentSecretRuntime,
  type AgentSecretSender,
  type AgentSecretVault,
} from "../../src/main/agent-secret-ipc";
import { AGENT_SECRET_SAVE_ERRORS } from "../../src/shared/agent-secrets";
import {
  CredentialVault,
  type CredentialEncryptionBackend,
  type CredentialVaultPersistence,
  type AgentSecretVaultWrite,
} from "../../src/main/credential-vault";
import type {
  RuntimeAgentSecretDelivery,
  RuntimeAgentSecretDeliveryOutcome,
} from "../../src/main/runtime-agent-secret-coordinator";
import { agentSecretReference } from "../../src/shared/agent-secrets";
import { BACKEND_CREDENTIAL_MASK } from "../../src/shared/backend-credentials";
import { DESKTOP_IPC } from "../../src/shared/desktop-ipc";

const SECRET = "tskey-auth-kQ7xZ9pL2mN4";
const CONVERSATION_ID = randomUUID();
const OTHER_CONVERSATION_ID = randomUUID();
const EXPIRES_AT = "2026-10-30T10:00:00.000Z";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

class FakeVault implements AgentSecretVault {
  readonly writes: string[] = [];
  readonly deletes: string[] = [];
  write: AgentSecretVaultWrite | Error = "stored";

  async setAgentSecret(requestId: string): Promise<AgentSecretVaultWrite> {
    this.writes.push(requestId);
    if (this.write instanceof Error) throw this.write;
    return this.write;
  }

  async deleteAgentSecret(requestId: string): Promise<boolean> {
    this.deletes.push(requestId);
    return true;
  }
}

class FakeRuntime implements AgentSecretRuntime {
  readonly deliveries: RuntimeAgentSecretDelivery[] = [];
  outcome: RuntimeAgentSecretDeliveryOutcome | Error | null = null;
  hold = false;
  private release: (() => void) | null = null;

  async deliverAgentSecret(delivery: RuntimeAgentSecretDelivery): Promise<RuntimeAgentSecretDeliveryOutcome> {
    this.deliveries.push(delivery);
    if (this.hold) await new Promise<void>((resolve) => { this.release = resolve; });
    const outcome = this.outcome ?? { status: "delivered", expiresAt: EXPIRES_AT, storage: delivery.vaulted ? "keychain" : "memory" };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  finish(outcome: RuntimeAgentSecretDeliveryOutcome): void {
    this.outcome = outcome;
    this.hold = false;
    this.release?.();
  }
}

class MemoryPersistence implements CredentialVaultPersistence {
  value: string | null = null;
  async read(): Promise<string | null> { return this.value; }
  async write(value: string): Promise<void> { this.value = value; }
}

class TestEncryption implements CredentialEncryptionBackend {
  available = true;
  async availability() {
    return this.available
      ? { available: true as const, provider: "keychain" as const, message: null }
      : { available: false as const, provider: "unavailable" as const, message: "Secure credential storage is unavailable on this system." };
  }
  async encrypt(plainText: string): Promise<Buffer> { return Buffer.from(`protected:${plainText}`, "utf8"); }
  async decrypt(encrypted: Buffer) {
    return { plainText: encrypted.toString("utf8").slice("protected:".length), shouldReEncrypt: false };
  }
}

function setup(options: {
  vault?: AgentSecretVault | null;
  runtime?: AgentSecretRuntime | null;
  sender?: AgentSecretSender | Error;
} = {}) {
  const handlers = new Map<string, Handler>();
  const vault = options.vault === undefined ? new FakeVault() : options.vault;
  const runtime = options.runtime === undefined ? new FakeRuntime() : options.runtime;
  const assertTrusted = vi.fn((_event: IpcMainInvokeEvent, received: number, expected: number): AgentSecretSender => {
    if (options.sender instanceof Error) throw options.sender;
    if (received !== expected) throw new Error("Rejected untrusted renderer request");
    return options.sender ?? { role: "main" };
  });
  registerAgentSecretIpc({
    ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } } as never,
    assertTrusted,
    vault: () => vault,
    runtime: () => runtime,
  });
  const handler = handlers.get(DESKTOP_IPC.saveAgentSecret);
  if (!handler) throw new Error("The save handler was not registered");
  const invoke = (...args: unknown[]) => handler({ sender: {} } as IpcMainInvokeEvent, ...args);
  return { invoke, vault, runtime, assertTrusted };
}

function request(overrides: Record<string, unknown> = {}) {
  return { conversationId: CONVERSATION_ID, requestId: randomUUID(), secret: SECRET, ...overrides };
}

function delivered(runtime: AgentSecretRuntime | null): void {
  (runtime as FakeRuntime).outcome = { status: "delivered", expiresAt: EXPIRES_AT, storage: "keychain" };
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
});

afterEach(() => {
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      expect(`${error.message}\n${error.stack ?? ""}`).not.toContain(SECRET);
      return error;
    }
  }
  throw new Error("Expected the save to fail");
}

describe("agent secret save IPC senders", () => {
  it("accepts the main window", async () => {
    const { invoke, runtime, assertTrusted } = setup();
    delivered(runtime);
    const save = request();
    await expect(invoke(save)).resolves.toEqual({ status: "saved", expiresAt: EXPIRES_AT, storage: "keychain" });
    expect(assertTrusted).toHaveBeenCalledWith(expect.anything(), 1, 1);
    expect((runtime as FakeRuntime).deliveries).toEqual([{ ...save, vaulted: true }]);
  });

  it("accepts a detached chat window that owns the conversation", async () => {
    const { invoke, runtime } = setup({ sender: { role: "detached-chat", conversationId: CONVERSATION_ID } });
    delivered(runtime);
    await expect(invoke(request())).resolves.toMatchObject({ status: "saved" });
  });

  it("rejects a detached chat window for another conversation before touching the vault", async () => {
    const { invoke, vault, runtime } = setup({ sender: { role: "detached-chat", conversationId: OTHER_CONVERSATION_ID } });
    expect((await failure(invoke(request()))).message).toBe(AGENT_SECRET_SAVE_ERRORS.foreignConversation);
    expect((vault as FakeVault).writes).toEqual([]);
    expect((runtime as FakeRuntime).deliveries).toEqual([]);
  });

  it("rejects untrusted senders and unexpected argument counts", async () => {
    const untrusted = setup({ sender: new Error("Rejected untrusted renderer request") });
    expect((await failure(untrusted.invoke(request()))).message).toBe("Rejected untrusted renderer request");
    expect((untrusted.vault as FakeVault).writes).toEqual([]);
    const extra = setup();
    expect((await failure(extra.invoke(request(), "extra"))).message).toBe("Rejected untrusted renderer request");
    expect((extra.vault as FakeVault).writes).toEqual([]);
  });
});

describe("agent secret save IPC values", () => {
  it("trims the value before storing and delivering it", async () => {
    const { invoke, runtime } = setup();
    delivered(runtime);
    await invoke(request({ secret: `  ${SECRET}\n` }));
    expect((runtime as FakeRuntime).deliveries[0]?.secret).toBe(SECRET);
  });

  it.each([
    ["a non-string value", 42, "Paste the secret as text."],
    ["only whitespace", "   \n ", "Paste the secret. Only spaces or line breaks were entered."],
    ["the mask", BACKEND_CREDENTIAL_MASK, "Paste the secret itself. The masked placeholder cannot be saved."],
    ["a multi-line value", "tskey\nauth-key", "The secret must be on a single line."],
    ["a short value", "abc", "The secret must be at least 4 characters long."],
    ["an oversized value", "a".repeat(16_385), "The secret is longer than 16,384 characters."],
  ])("rejects %s with the card's fixed message", async (_label, secret, message) => {
    const { invoke, vault, runtime } = setup();
    expect((await failure(invoke(request({ secret })))).message).toBe(message);
    expect((vault as FakeVault).writes).toEqual([]);
    expect((runtime as FakeRuntime).deliveries).toEqual([]);
  });

  it.each([
    ["a non-uuid request", { requestId: "request-1" }],
    ["a non-uuid conversation", { conversationId: "conversation" }],
    ["an extra field", { file: "/tmp/secret" }],
  ])("rejects %s as invalid", async (_label, overrides) => {
    const { invoke, vault } = setup();
    expect((await failure(invoke(request(overrides)))).message).toBe(AGENT_SECRET_SAVE_ERRORS.invalid);
    expect((vault as FakeVault).writes).toEqual([]);
    expect((await failure(invoke(null))).message).toBe(AGENT_SECRET_SAVE_ERRORS.invalid);
    expect((await failure(invoke({ conversationId: CONVERSATION_ID, requestId: randomUUID() }))).message).toBe(AGENT_SECRET_SAVE_ERRORS.invalid);
  });
});

describe("agent secret save IPC storage", () => {
  it("delivers memory-only when secure storage is unavailable or fails", async () => {
    for (const write of ["unavailable", new Error("keyring detail")] as const) {
      const vault = new FakeVault();
      vault.write = write;
      const { invoke, runtime } = setup({ vault });
      await expect(invoke(request())).resolves.toEqual({ status: "saved", expiresAt: EXPIRES_AT, storage: "memory" });
      expect((runtime as FakeRuntime).deliveries[0]?.vaulted).toBe(false);
    }
  });

  it("never rolls back an entry it did not write", async () => {
    const vault = new FakeVault();
    vault.write = "exists";
    const runtime = new FakeRuntime();
    runtime.outcome = { status: "rejected", reason: "not-pending" };
    const { invoke } = setup({ vault, runtime });
    expect((await failure(invoke(request()))).message).toBe(AGENT_SECRET_SAVE_ERRORS.notPending);
    expect(runtime.deliveries[0]?.vaulted).toBe(false);
    expect(vault.deletes).toEqual([]);
  });

  it.each([
    ["not-pending", AGENT_SECRET_SAVE_ERRORS.notPending],
    ["ended", AGENT_SECRET_SAVE_ERRORS.notPending],
    ["file-failed", AGENT_SECRET_SAVE_ERRORS.fileFailed],
    ["limit", AGENT_SECRET_SAVE_ERRORS.limit],
    ["unavailable", AGENT_SECRET_SAVE_ERRORS.runtimeUnavailable],
  ] as const)("removes the vault entry when the runtime rejects with %s", async (reason, message) => {
    const runtime = new FakeRuntime();
    runtime.outcome = { status: "rejected", reason };
    const { invoke, vault } = setup({ runtime });
    const save = request();
    expect((await failure(invoke(save))).message).toBe(message);
    expect((vault as FakeVault).deletes).toEqual([save.requestId]);
  });

  it("removes the vault entry when delivery throws", async () => {
    const runtime = new FakeRuntime();
    runtime.outcome = new Error(`worker failed with ${SECRET}`);
    const { invoke, vault } = setup({ runtime });
    expect((await failure(invoke(request()))).message).toBe(AGENT_SECRET_SAVE_ERRORS.runtimeUnavailable);
    expect((vault as FakeVault).deletes).toHaveLength(1);
  });

  it("fails without writing when the vault or runtime is not ready", async () => {
    const starting = setup({ vault: null });
    expect((await failure(starting.invoke(request()))).message).toBe(AGENT_SECRET_SAVE_ERRORS.storageStarting);
    const stopped = setup({ runtime: null });
    expect((await failure(stopped.invoke(request()))).message).toBe(AGENT_SECRET_SAVE_ERRORS.runtimeUnavailable);
    expect((stopped.vault as FakeVault).writes).toEqual([]);
  });

  it("refuses a second save for the same request while one is in flight", async () => {
    const { invoke, vault, runtime } = setup();
    (runtime as FakeRuntime).hold = true;
    const save = request();
    const first = invoke(save);
    await vi.waitFor(() => expect((runtime as FakeRuntime).deliveries).toHaveLength(1));
    expect((await failure(invoke({ ...save, secret: "another-secret" }))).message).toBe(AGENT_SECRET_SAVE_ERRORS.notPending);
    expect((vault as FakeVault).writes).toEqual([save.requestId]);
    (runtime as FakeRuntime).finish({ status: "delivered", expiresAt: EXPIRES_AT, storage: "keychain" });
    await expect(first).resolves.toMatchObject({ status: "saved" });
    expect((vault as FakeVault).deletes).toEqual([]);
  });

  it("stores in the real vault and rolls back on rejection", async () => {
    const encryption = new TestEncryption();
    const persistence = new MemoryPersistence();
    const vault = new CredentialVault(encryption, persistence);
    const runtime = new FakeRuntime();
    const { invoke } = setup({ vault, runtime });

    const kept = request();
    runtime.outcome = { status: "delivered", expiresAt: EXPIRES_AT, storage: "keychain" };
    await expect(invoke(kept)).resolves.toMatchObject({ storage: "keychain" });
    await expect(vault.resolve(agentSecretReference(kept.requestId))).resolves.toBe(SECRET);

    const rejected = request();
    runtime.outcome = { status: "rejected", reason: "limit" };
    await failure(invoke(rejected));
    await expect(vault.status(agentSecretReference(rejected.requestId))).resolves.toEqual({ hasSecret: false, credentialGeneration: null });

    runtime.outcome = { status: "rejected", reason: "not-pending" };
    await failure(invoke({ ...kept, secret: "replacement-secret" }));
    await expect(vault.resolve(agentSecretReference(kept.requestId))).resolves.toBe(SECRET);
    expect(persistence.value).not.toContain(SECRET);
  });
});
