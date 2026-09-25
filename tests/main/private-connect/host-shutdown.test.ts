import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const serviceCreation = vi.hoisted(() => ({ pending: null as null | ((service: unknown) => void) }));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => "active" }),
  safeStorage: {},
}));

vi.mock("../../../src/main/private-connect/store", () => ({
  createPrivateConnectStoreEncryption: vi.fn(async () => ({})),
  PrivateConnectStore: class {},
}));

vi.mock("../../../src/main/private-connect/service", () => ({
  PrivateConnectService: {
    create: vi.fn(() => new Promise((resolve) => { serviceCreation.pending = resolve; })),
  },
}));

import { PrivateConnectHost } from "../../../src/main/private-connect/host";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Private Connect host shutdown evidence", () => {
  it("reports the service step when shutdown races an unfinished initialization", async () => {
    const userDataDirectory = await mkdtemp(join(tmpdir(), "inertia-private-connect-host-"));
    roots.push(userDataDirectory);
    const host = PrivateConnectHost.create({
      userDataDirectory,
      staticRoot: userDataDirectory,
      buildVersion: "test",
      runtime: {} as never,
      window: () => null,
      assertTrusted: () => undefined,
    });
    await vi.waitFor(() => expect(serviceCreation.pending).not.toBeNull());

    const shutdown = host.shutdown();
    expect(host.shutdownStep()).toBe("awaiting-initialization");

    let finishServiceShutdown!: () => void;
    const service = {
      step: "stopping-gateway",
      shutdownStep() { return this.step; },
      shutdown: vi.fn(() => new Promise<void>((resolve) => { finishServiceShutdown = resolve; })),
    };
    serviceCreation.pending!(service);
    await vi.waitFor(() => expect(service.shutdown).toHaveBeenCalledOnce());
    expect(host.shutdownStep()).toBe("stopping-gateway");

    service.step = "stopped";
    finishServiceShutdown();
    await shutdown;
    expect(host.shutdownStep()).toBe("stopped");
  });
});
