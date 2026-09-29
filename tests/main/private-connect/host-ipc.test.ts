import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
const service = vi.hoisted(() => ({
  setPrivacyLocked: vi.fn(async () => undefined),
  startIfEnabled: vi.fn(async () => undefined),
  state: vi.fn(() => ({ status: "off" })),
  denyPairing: vi.fn(async () => undefined),
  revokeDevice: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  },
  powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => "active" }),
  safeStorage: {},
}));

vi.mock("../../../src/main/private-connect/store", () => ({
  createPrivateConnectStoreEncryption: vi.fn(async () => ({})),
  PrivateConnectStore: class {},
}));

vi.mock("../../../src/main/private-connect/service", () => ({
  PrivateConnectService: { create: vi.fn(async () => service) },
}));

import { PrivateConnectHost } from "../../../src/main/private-connect/host";
import { PRIVATE_CONNECT_IPC } from "../../../src/shared/private-connect/ipc";

const IDENTIFIER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const roots: string[] = [];

afterEach(async () => {
  electron.handlers.clear();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function readyHost(): Promise<void> {
  const userDataDirectory = await mkdtemp(join(tmpdir(), "inertia-private-connect-ipc-"));
  roots.push(userDataDirectory);
  PrivateConnectHost.create({
    userDataDirectory,
    staticRoot: userDataDirectory,
    buildVersion: "test",
    runtime: {} as never,
    window: () => null,
    assertTrusted: () => undefined,
  });
  await vi.waitFor(() => expect(service.startIfEnabled).toHaveBeenCalledOnce());
}

describe("Private Connect host IPC", () => {
  it.each([
    [PRIVATE_CONNECT_IPC.denyPairing, "denyPairing", "Invalid Private Connect pairing request."],
    [PRIVATE_CONNECT_IPC.revokeDevice, "revokeDevice", "Invalid Private Connect device."],
  ] as const)("rejects identifiers that are not bounded UUIDs on %s", async (channel, method, message) => {
    await readyHost();
    const handler = electron.handlers.get(channel)!;

    for (const value of ["not-an-identifier", `${IDENTIFIER}${"0".repeat(1_000_000)}`, ""]) {
      await expect(Promise.resolve(handler({}, value))).rejects.toThrow(message);
    }
    expect(service[method]).not.toHaveBeenCalled();

    await handler({}, IDENTIFIER);
    expect(service[method]).toHaveBeenCalledExactlyOnceWith(IDENTIFIER);
  });
});
