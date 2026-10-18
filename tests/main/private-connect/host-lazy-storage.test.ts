import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  isAsyncEncryptionAvailable: vi.fn(async () => true),
}));
const service = vi.hoisted(() => ({
  setPrivacyLocked: vi.fn(async () => undefined),
  startIfEnabled: vi.fn(async () => undefined),
  setNotice: vi.fn(),
  state: vi.fn(() => ({ available: true, enabled: false, status: "off" })),
  setEnabled: vi.fn(async (enabled: boolean) => ({ available: true, enabled, status: enabled ? "ready" : "off" })),
  prepareForUpdate: vi.fn(async () => true),
  releaseUpdatePreparation: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
}));
const serviceFactory = vi.hoisted(() => ({ create: vi.fn(async () => service) }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  },
  powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => "active" }),
  safeStorage: {
    isAsyncEncryptionAvailable: electron.isAsyncEncryptionAvailable,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

vi.mock("../../../src/main/private-connect/service", () => ({
  PrivateConnectService: serviceFactory,
}));

import { PrivateConnectHost } from "../../../src/main/private-connect/host";
import { PRIVATE_CONNECT_IPC } from "../../../src/shared/private-connect/ipc";

const roots: string[] = [];

afterEach(async () => {
  electron.handlers.clear();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function launch(previouslyEnabled: boolean): Promise<{ host: PrivateConnectHost; userDataDirectory: string }> {
  const userDataDirectory = await mkdtemp(join(tmpdir(), "inertia-private-connect-lazy-"));
  roots.push(userDataDirectory);
  if (previouslyEnabled) await writeFile(join(userDataDirectory, "private-connect.vault"), "c3RvcmU=");
  const host = PrivateConnectHost.create({
    userDataDirectory,
    staticRoot: userDataDirectory,
    buildVersion: "test",
    runtime: {} as never,
    window: () => null,
    assertTrusted: () => undefined,
  });
  return { host, userDataDirectory };
}

describe("Private Connect secure storage check", () => {
  it("never reads secure storage during a launch and quit that do not use Private Connect", async () => {
    const { host, userDataDirectory } = await launch(false);

    await host.shutdown();

    expect(electron.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(serviceFactory.create).not.toHaveBeenCalled();
    expect(await readFile(join(userDataDirectory, "private-connect-migration-v1"), "utf8")).toBe("private-connect-migration-v1\n");
  });

  it("checks secure storage at launch when Private Connect was enabled before", async () => {
    const { host } = await launch(true);

    await vi.waitFor(() => expect(service.startIfEnabled).toHaveBeenCalledOnce());
    expect(electron.isAsyncEncryptionAvailable).toHaveBeenCalledOnce();
    await host.shutdown();
    expect(service.shutdown).toHaveBeenCalledOnce();
  });

  it("checks secure storage once when the settings section asks for the state", async () => {
    const { host } = await launch(false);
    const getState = electron.handlers.get(PRIVATE_CONNECT_IPC.getState)!;

    expect(await getState({})).toMatchObject({ available: false, statusMessage: "Private Connect secure storage is initializing." });
    await vi.waitFor(() => expect(service.startIfEnabled).toHaveBeenCalledOnce());
    expect(await getState({})).toMatchObject({ available: true });
    expect(electron.isAsyncEncryptionAvailable).toHaveBeenCalledOnce();
    expect(serviceFactory.create).toHaveBeenCalledOnce();
    await host.shutdown();
  });

  it("checks secure storage before enabling when the state was never requested", async () => {
    const { host } = await launch(false);
    const setEnabled = electron.handlers.get(PRIVATE_CONNECT_IPC.setEnabled)!;

    await expect(Promise.resolve(setEnabled({}, { enabled: true }))).resolves.toMatchObject({ enabled: true });
    expect(electron.isAsyncEncryptionAvailable).toHaveBeenCalledOnce();
    expect(service.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    await host.shutdown();
  });

  it("checks secure storage again after a failed check instead of keeping the failure", async () => {
    electron.isAsyncEncryptionAvailable.mockResolvedValueOnce(false);
    const { host } = await launch(false);
    const getState = electron.handlers.get(PRIVATE_CONNECT_IPC.getState)!;
    const setEnabled = electron.handlers.get(PRIVATE_CONNECT_IPC.setEnabled)!;

    await getState({});
    await vi.waitFor(() => expect(host.state()).toMatchObject({
      available: false,
      statusMessage: "Secure platform storage is unavailable; Private Connect remains disabled.",
    }));
    expect(serviceFactory.create).not.toHaveBeenCalled();

    await expect(Promise.resolve(setEnabled({}, { enabled: true }))).resolves.toMatchObject({ enabled: true });
    expect(electron.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(2);
    expect(serviceFactory.create).toHaveBeenCalledOnce();
    await host.shutdown();
  });

  it("keeps a later first use closed while an update is being prepared", async () => {
    const { host } = await launch(false);

    await expect(host.prepareForUpdate()).resolves.toBe(true);
    expect(electron.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    await electron.handlers.get(PRIVATE_CONNECT_IPC.getState)!({});
    await vi.waitFor(() => expect(service.prepareForUpdate).toHaveBeenCalledOnce());
    await host.releaseUpdatePreparation();
    expect(service.releaseUpdatePreparation).toHaveBeenCalledOnce();
    await host.shutdown();
  });

  it("does not start a first use after quit has begun", async () => {
    const { host } = await launch(false);

    await host.shutdown();
    expect(await electron.handlers.get(PRIVATE_CONNECT_IPC.getState)!({})).toMatchObject({ available: false });
    await expect(Promise.resolve(electron.handlers.get(PRIVATE_CONNECT_IPC.setEnabled)!({}, { enabled: true }))).rejects.toThrow("Private Connect is shutting down.");
    expect(electron.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
  });
});
