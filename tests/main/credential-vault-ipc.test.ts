import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { CredentialVaultError } from "../../src/main/credential-vault";
import { registerCredentialVaultIpc } from "../../src/main/credential-vault-ipc";
import { DESKTOP_IPC } from "../../src/shared/desktop-ipc";

const SECRET = "sk-test-credential-never-echoed";

type Vault = {
  setForProfile: (profileId: string, secret: string) => Promise<unknown>;
  clearForProfile: (profileId: string) => Promise<unknown>;
  stateForProfile: (profileId: string) => Promise<unknown>;
};

function harness(vault: Vault | null) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(name, handler);
    },
  } as unknown as IpcMain;
  const event = { sender: {} } as IpcMainInvokeEvent;
  registerCredentialVaultIpc(ipcMain, () => vault, () => undefined);
  return async (channel: string, input: unknown): Promise<unknown> =>
    await handlers.get(channel)!(event, input);
}

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    setForProfile: vi.fn(async (profileId: string) => ({ profileId, hasSecret: true })),
    clearForProfile: vi.fn(async (profileId: string) => ({ profileId, hasSecret: false })),
    stateForProfile: vi.fn(async (profileId: string) => ({ profileId, hasSecret: false })),
    ...overrides,
  };
}

async function failure(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("The credential request was expected to fail.");
}

describe("credential vault IPC", () => {
  it("explains empty, blank and masked keys before touching the vault", async () => {
    const target = vault();
    const invoke = harness(target);

    for (const secret of ["", "   ", "\n\t"]) {
      await expect(invoke(DESKTOP_IPC.setBackendCredential, { profileId: "custom:key", secret }))
        .rejects.toThrow("Paste an API key or token. Only spaces or line breaks were entered.");
    }
    await expect(invoke(DESKTOP_IPC.setBackendCredential, { profileId: "custom:key", secret: "••••••••" }))
      .rejects.toThrow("Paste a new API key or token. The masked placeholder cannot be saved.");
    await expect(invoke(DESKTOP_IPC.setBackendCredential, { profileId: "custom:key", secret: "a\nb" }))
      .rejects.toThrow("The API key or token must be on a single line.");
    expect(target.setForProfile).not.toHaveBeenCalled();
  });

  it("saves the trimmed key", async () => {
    const target = vault();
    const invoke = harness(target);

    await invoke(DESKTOP_IPC.setBackendCredential, { profileId: "custom:key", secret: `  ${SECRET}\n` });

    expect(target.setForProfile).toHaveBeenCalledWith("custom:key", SECRET);
  });

  it.each([
    ["storage-unavailable", "The key was not saved because secure storage is not available on this computer."],
    ["encryption-failed", "The key was not saved because secure storage could not encrypt it."],
    ["persistence-failed", "The key was not saved because the secure credential file could not be written."],
    ["storage-corrupt", "The key was not saved because the secure credential file is damaged."],
  ] as const)("names the %s cause in plain English without the key", async (code, message) => {
    const invoke = harness(vault({
      setForProfile: async () => {
        throw new CredentialVaultError(code, `internal detail ${SECRET}`);
      },
    }));

    const text = await failure(invoke(DESKTOP_IPC.setBackendCredential, {
      profileId: "custom:key",
      secret: SECRET,
    }));

    expect(text).toBe(message);
    expect(text).not.toContain(SECRET);
  });

  it("passes the keyring guidance through when Linux has no safe store", async () => {
    const guidance = "Inertia cannot store keys safely on this system because no keyring is available. "
      + "Install or unlock a Secret Service keyring, such as GNOME Keyring or KWallet, then restart Inertia.";
    const invoke = harness(vault({
      setForProfile: async () => {
        throw Object.assign(new CredentialVaultError("storage-unavailable", "internal"), { publicDetail: guidance });
      },
    }));

    expect(await failure(invoke(DESKTOP_IPC.setBackendCredential, { profileId: "custom:key", secret: SECRET })))
      .toBe(`The key was not saved. ${guidance}`);
  });

  it("explains removal, read and startup failures without internal detail", async () => {
    const failing = harness(vault({
      clearForProfile: async () => {
        throw new CredentialVaultError("persistence-failed", `disk path ${SECRET}`);
      },
      stateForProfile: async () => {
        throw new Error(`raw failure ${SECRET}`);
      },
    }));

    expect(await failure(failing(DESKTOP_IPC.clearBackendCredential, { profileId: "custom:key" })))
      .toBe("The key was not removed because the secure credential file could not be written.");
    expect(await failure(failing(DESKTOP_IPC.getBackendCredentialState, { profileId: "custom:key" })))
      .toBe("The saved key could not be checked because secure storage failed.");
    expect(await failure(harness(null)(DESKTOP_IPC.setBackendCredential, {
      profileId: "custom:key",
      secret: SECRET,
    }))).toBe("The key was not saved because secure storage is still starting. Try again in a moment.");
  });
});
