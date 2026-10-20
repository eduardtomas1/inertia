import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";

import {
  CredentialVault,
  CredentialVaultError,
  type CredentialEncryptionBackend,
  type CredentialVaultPersistence,
} from "../../src/main/credential-vault";
import { registerCredentialVaultIpc } from "../../src/main/credential-vault-ipc";
import { registerInitiativeMcpSecretIpc } from "../../src/main/initiative-mcp-secret-ipc";
import { runtimeCredentialBroker } from "../../src/main/runtime-credential-broker";
import { initiativeMcpSecretReference } from "../../src/node/initiative-mcp-secret-reference";
import { backendSecretReferenceForProfile } from "../../src/node/backend-secret-reference";
import { DESKTOP_IPC } from "../../src/shared/desktop-ipc";
import {
  initiativeMcpServerDestination,
  MAX_INITIATIVE_MCP_SECRET_REFERENCES_PER_SERVER,
  MAX_INITIATIVE_MCP_SECRET_SERVERS,
  type InitiativeMcpTransport,
} from "../../src/shared/initiative-mcp";

const INITIATIVE = "11111111-1111-4111-8111-111111111111";
const OTHER_INITIATIVE = "44444444-4444-4444-8444-444444444444";
const SERVER = "22222222-2222-4222-8222-222222222222";
const SECRET = "fixture-mcp-secret-3f9d";
const UNTRUSTED = "Rejected untrusted renderer request";
const HTTP: InitiativeMcpTransport = {
  kind: "http",
  url: "https://mcp.example.com/mcp",
  headers: [{ name: "Authorization", secret: true }, { name: "X-Team", value: "checkout" }],
};
const STDIO: InitiativeMcpTransport = {
  kind: "stdio",
  command: "npx",
  args: ["-y", "@example/docs-mcp"],
  env: [{ name: "TOKEN", secret: true }],
};
const httpReference = (initiativeId = INITIATIVE, transport: InitiativeMcpTransport = HTTP) =>
  initiativeMcpSecretReference(initiativeId, SERVER, "header:authorization", initiativeMcpServerDestination({ transport }));

class MemoryPersistence implements CredentialVaultPersistence {
  value: string | null = null;
  async read(): Promise<string | null> { return this.value; }
  async write(value: string): Promise<void> { this.value = value; }
}

class TestEncryption implements CredentialEncryptionBackend {
  available = true;
  failEncrypt = false;
  async availability() {
    return this.available
      ? { available: true as const, provider: "keychain" as const, message: null }
      : { available: false as const, provider: "unavailable" as const, message: "Secure credential storage is unavailable on this system." };
  }
  async encrypt(plainText: string): Promise<Buffer> {
    if (this.failEncrypt) throw new Error(`keychain failure ${plainText}`);
    return Buffer.from(`protected:${Buffer.from(plainText).toString("base64")}`, "utf8");
  }
  async decrypt(encrypted: Buffer) {
    const value = encrypted.toString("utf8");
    return { plainText: Buffer.from(value.slice("protected:".length), "base64").toString("utf8"), shouldReEncrypt: false };
  }
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const mainWindow = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const detachedWindow = { sender: { id: 2 } } as unknown as IpcMainInvokeEvent;

function harness(options: { vault?: CredentialVault | null } = {}) {
  const persistence = new MemoryPersistence();
  const encryption = new TestEncryption();
  const vault = options.vault === undefined ? new CredentialVault(encryption, persistence) : options.vault;
  const handlers = new Map<string, Handler>();
  registerInitiativeMcpSecretIpc({
    ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } } as never,
    channels: { set: DESKTOP_IPC.setInitiativeMcpSecret, state: DESKTOP_IPC.getInitiativeMcpSecretState },
    assertTrusted: (event, count, expected) => {
      if (event !== mainWindow || count !== expected) throw new Error(UNTRUSTED);
    },
    vault: () => vault,
  });
  const invoke = async (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
    await handlers.get(channel)!(event, ...args);
  return { vault, persistence, encryption, invoke };
}

describe("initiative MCP secret IPC", () => {
  it("stores a secret under the derived reference and answers only whether it is set", async () => {
    const { vault, persistence, invoke } = harness();
    const answer = await invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, {
      initiativeId: INITIATIVE, serverId: SERVER, transport: HTTP, slot: "header:authorization", value: SECRET,
    });
    expect(answer).toEqual({ slots: { "header:authorization": true }, storageAvailable: true });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    // Encrypted at rest; the runtime resolves it through the same derivation.
    expect(persistence.value).not.toContain(SECRET);
    expect(await runtimeCredentialBroker(() => vault!).resolve(httpReference())).toBe(SECRET);
    expect(await invoke(DESKTOP_IPC.getInitiativeMcpSecretState, mainWindow, {
      initiativeId: INITIATIVE, serverId: SERVER, transport: HTTP, slots: ["header:authorization"],
    })).toEqual({ slots: { "header:authorization": true }, storageAvailable: true });
    // Another initiative's identical server and slot is a different entry.
    expect(await invoke(DESKTOP_IPC.getInitiativeMcpSecretState, mainWindow, {
      initiativeId: OTHER_INITIATIVE, serverId: SERVER, transport: HTTP, slots: ["header:authorization"],
    })).toEqual({ slots: { "header:authorization": false }, storageAvailable: true });
    // So is the same server at another URL: its secret never follows it there.
    const moved = { ...HTTP, url: "https://attacker.example.com/mcp" };
    expect(await invoke(DESKTOP_IPC.getInitiativeMcpSecretState, mainWindow, {
      initiativeId: INITIATIVE, serverId: SERVER, transport: moved, slots: ["header:authorization"],
    })).toEqual({ slots: { "header:authorization": false }, storageAvailable: true });
    expect(await runtimeCredentialBroker(() => vault!).resolve(httpReference(INITIATIVE, moved))).toBeNull();
  });

  it("refuses secrets too short to redact with a readable message", async () => {
    const { persistence, invoke } = harness();
    for (const value of ["x", "1234567", "Bearer 1234567"]) {
      const failure = invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, {
        initiativeId: INITIATIVE, serverId: SERVER, transport: HTTP, slot: "header:authorization", value,
      });
      await expect(failure).rejects.toThrow(/at least 8 characters/u);
    }
    expect(persistence.value).toBeNull();
  });

  it("bounds the servers and references one initiative can fill, counting only those still set", async () => {
    const { vault, invoke } = harness();
    const serverId = (index: number) => `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`;
    const set = (server: string, transport: InitiativeMcpTransport, slot: string) => invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, {
      initiativeId: INITIATIVE, serverId: server, transport, slot, value: SECRET,
    });
    for (let index = 0; index < MAX_INITIATIVE_MCP_SECRET_SERVERS; index += 1) {
      await set(serverId(index), HTTP, "header:authorization");
    }
    await expect(set(serverId(99), HTTP, "header:authorization")).rejects.toThrow(/as many MCP secrets as Inertia allows/u);
    // Another initiative has its own budget.
    await expect(invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, {
      initiativeId: OTHER_INITIATIVE, serverId: serverId(99), transport: HTTP, slot: "header:authorization", value: SECRET,
    })).resolves.toMatchObject({ storageAvailable: true });
    // A server the runtime removed (its secret forgotten) frees its place.
    const removed = initiativeMcpSecretReference(INITIATIVE, serverId(0), "header:authorization", initiativeMcpServerDestination({ transport: HTTP }));
    await vault!.forget(removed);
    await expect(set(serverId(99), HTTP, "header:authorization")).resolves.toMatchObject({ storageAvailable: true });

    // One server cannot fill the vault by changing its destination either.
    const destinations = Array.from({ length: MAX_INITIATIVE_MCP_SECRET_REFERENCES_PER_SERVER + 1 }, (_, index) => ({
      ...HTTP, url: `https://mcp${index}.example.com/mcp`,
    }));
    for (const transport of destinations.slice(0, MAX_INITIATIVE_MCP_SECRET_REFERENCES_PER_SERVER - 1)) {
      await set(serverId(1), transport, "header:authorization");
    }
    await expect(set(serverId(1), destinations.at(-1)!, "header:authorization")).rejects.toThrow(/as many MCP secrets/u);
    // Writing an existing reference again is always allowed.
    await expect(set(serverId(1), destinations[0]!, "header:authorization")).resolves.toMatchObject({ storageAvailable: true });
  });

  it("derives references that can never name a backend credential", () => {
    const destination = initiativeMcpServerDestination({ transport: HTTP });
    const reference = initiativeMcpSecretReference(INITIATIVE, SERVER, "header:authorization", destination);
    expect(reference).toMatch(/^secret:mcp:[0-9a-f]{64}$/u);
    expect(reference).not.toBe(backendSecretReferenceForProfile("anthropic"));
    expect(initiativeMcpSecretReference(INITIATIVE.toUpperCase(), SERVER, "header:authorization", destination)).toBe(reference);
    expect(initiativeMcpSecretReference(INITIATIVE, SERVER, "env:AUTHORIZATION", destination)).not.toBe(reference);
    expect(initiativeMcpSecretReference(INITIATIVE, SERVER, "header:authorization", initiativeMcpServerDestination({ transport: STDIO })))
      .not.toBe(reference);
    expect(() => initiativeMcpSecretReference("initiative", SERVER, "header:authorization", destination)).toThrow();
    expect(() => initiativeMcpSecretReference(INITIATIVE, SERVER, "secret:backend:x", destination)).toThrow();
    expect(() => initiativeMcpSecretReference(INITIATIVE, SERVER, "header:authorization", "")).toThrow();
  });

  it("refuses other windows, extra arguments and malformed requests before touching the vault", async () => {
    const { persistence, invoke } = harness();
    const request = { initiativeId: INITIATIVE, serverId: SERVER, transport: HTTP, slot: "header:authorization", value: SECRET };
    await expect(invoke(DESKTOP_IPC.setInitiativeMcpSecret, detachedWindow, request)).rejects.toThrow(UNTRUSTED);
    await expect(invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, request, "extra")).rejects.toThrow(UNTRUSTED);
    await expect(invoke(DESKTOP_IPC.getInitiativeMcpSecretState, detachedWindow, {
      initiativeId: INITIATIVE, serverId: SERVER, transport: HTTP, slots: ["header:authorization"],
    })).rejects.toThrow(UNTRUSTED);
    for (const invalid of [
      { ...request, slot: "secret:backend:abc" },
      { ...request, serverId: "server" },
      { ...request, slot: "header:x-team" },
      { ...request, transport: STDIO },
      { ...request, secretReference: "secret:backend:abc" },
    ]) {
      const failure = invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, invalid);
      await expect(failure).rejects.toThrow("The MCP secret request is invalid.");
      await failure.catch((error: Error) => expect(error.message).not.toContain(SECRET));
    }
    expect(persistence.value).toBeNull();
  });

  it("fails closed without leaking the value when storage is unavailable or encryption fails", async () => {
    const unavailable = harness();
    unavailable.encryption.available = false;
    const request = { initiativeId: INITIATIVE, serverId: SERVER, transport: STDIO, slot: "env:TOKEN", value: SECRET };
    await expect(unavailable.invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, request))
      .rejects.toThrow("Secure credential storage is unavailable on this system.");
    expect(await unavailable.invoke(DESKTOP_IPC.getInitiativeMcpSecretState, mainWindow, {
      initiativeId: INITIATIVE, serverId: SERVER, transport: STDIO, slots: ["env:TOKEN"],
    })).toEqual({ slots: { "env:TOKEN": false }, storageAvailable: false });

    const failing = harness();
    failing.encryption.failEncrypt = true;
    const failure = failing.invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, request);
    await expect(failure).rejects.toThrow("The backend credential could not be protected.");
    await failure.catch((error: Error) => expect(error.message).not.toContain(SECRET));
    expect(failing.persistence.value).toBeNull();

    const missing = harness({ vault: null });
    await expect(missing.invoke(DESKTOP_IPC.setInitiativeMcpSecret, mainWindow, request))
      .rejects.toThrow("Secure credential storage is unavailable on this system.");
  });

  it("validates the reference and value in the vault itself", async () => {
    const vault = new CredentialVault(new TestEncryption(), new MemoryPersistence());
    const reference = initiativeMcpSecretReference(INITIATIVE, SERVER, "env:TOKEN", initiativeMcpServerDestination({ transport: STDIO }));
    await expect(vault.setSecret("not-a-reference", SECRET)).rejects.toThrow(CredentialVaultError);
    await expect(vault.setSecret(reference, "a\nb")).rejects.toThrow("The secret is invalid.");
    await expect(vault.setSecret(reference, SECRET)).resolves.toMatchObject({ hasSecret: true });
  });

  it("is registered with the credential vault channels and the same main-window check", async () => {
    const handlers = new Map<string, Handler>();
    const vault = new CredentialVault(new TestEncryption(), new MemoryPersistence());
    registerCredentialVaultIpc(
      { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } } as never,
      () => vault,
      (event, count, expected) => {
        if (event !== mainWindow || count !== expected) throw new Error(UNTRUSTED);
      },
    );
    const request = { initiativeId: INITIATIVE, serverId: SERVER, transport: STDIO, slot: "env:TOKEN", value: SECRET };
    await expect(handlers.get(DESKTOP_IPC.setInitiativeMcpSecret)!(detachedWindow, request)).rejects.toThrow(UNTRUSTED);
    expect(await handlers.get(DESKTOP_IPC.setInitiativeMcpSecret)!(mainWindow, request))
      .toEqual({ slots: { "env:TOKEN": true }, storageAvailable: true });
    // Without a vault the channel refuses.
    const missing = new Map<string, Handler>();
    registerCredentialVaultIpc(
      { handle: (channel: string, handler: Handler) => { missing.set(channel, handler); } } as never,
      () => null,
      () => undefined,
    );
    await expect(missing.get(DESKTOP_IPC.setInitiativeMcpSecret)!(mainWindow, request))
      .rejects.toThrow("Secure credential storage is unavailable on this system.");
  });
});
