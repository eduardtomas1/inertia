import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { describe, expect, it, vi } from "vitest";

import { APP_UPDATE_IPC, registerAppUpdateIpc } from "../../src/main/app-update-ipc";
import type { AppUpdateInstallCoordinator } from "../../src/main/app-update-install";
import type { AppUpdateService } from "../../src/main/app-update";
import type { CanaryRollbackManager } from "../../src/main/canary-rollback";
import type { CanaryRollbackStatus } from "../../src/shared/desktop";

type Handler = (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => unknown;

function subject(options: {
  service?: { download(): Promise<unknown> };
  rollback?: { prepare(): Promise<CanaryRollbackStatus> } | null;
} = {}): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerAppUpdateIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
    } as unknown as IpcMain,
    currentVersion: () => "1.2.3",
    service: () => (options.service ?? null) as unknown as AppUpdateService | null,
    installCoordinator: () => null as AppUpdateInstallCoordinator | null,
    rollbackManager: () => (options.rollback ?? null) as unknown as CanaryRollbackManager | null,
    assertTrustedIpc: vi.fn(),
  });
  return handlers;
}

describe("application update IPC", () => {
  it("blocks a Canary update when the running package cannot become last-known-good", async () => {
    const download = vi.fn();
    const handlers = subject({
      service: { download },
      rollback: { prepare: vi.fn<() => Promise<CanaryRollbackStatus>>(async () => ({
        state: "failed", version: null, message: "digest mismatch",
      })) },
    });
    await expect(handlers.get(APP_UPDATE_IPC.downloadAppUpdate)!({} as IpcMainInvokeEvent))
      .rejects.toThrow("could not be retained");
    expect(download).not.toHaveBeenCalled();
  });

  it("starts the update only after verifying the exact running Canary version", async () => {
    const result = { revision: 2 };
    const download = vi.fn(async () => result);
    const handlers = subject({
      service: { download },
      rollback: { prepare: vi.fn<() => Promise<CanaryRollbackStatus>>(async () => ({
        state: "ready", version: "1.2.3", message: "verified",
      })) },
    });
    await expect(handlers.get(APP_UPDATE_IPC.downloadAppUpdate)!({} as IpcMainInvokeEvent))
      .resolves.toBe(result);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("reports rollback unavailable without a Canary manager", async () => {
    const handlers = subject();
    await expect(handlers.get(APP_UPDATE_IPC.getCanaryRollbackStatus)!({} as IpcMainInvokeEvent))
      .resolves.toEqual({
        state: "unavailable",
        version: null,
        message: "Rollback packages are available only in Inertia Canary.",
      });
  });
});
