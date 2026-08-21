import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { registerInertiaReleaseIpc } from "../../src/main/inertia-release-ipc";

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

function fakeIpcMain(): {
  ipcMain: IpcMain;
  handlers: Map<string, InvokeHandler>;
} {
  const handlers = new Map<string, InvokeHandler>();
  return {
    ipcMain: {
      handle: (channel: string, handler: InvokeHandler) => {
        handlers.set(channel, handler);
      },
    } as unknown as IpcMain,
    handlers,
  };
}

describe("Inertia release IPC", () => {
  it("resolves the Discord webhook only through the credential vault", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const resolve = vi.fn(async () =>
      "https://discord.com/api/webhooks/123/token");
    const assertTrusted = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>();
    registerInertiaReleaseIpc(
      ipcMain,
      fetch,
      () => ({ resolve }),
      assertTrusted,
    );

    const handler = handlers.get("inertia:send-discord-release-info");
    expect(handler).toBeDefined();
    await expect(handler?.({} as IpcMainInvokeEvent, {})).rejects.toThrow(
      "release repository URL is required",
    );
    expect(assertTrusted).toHaveBeenCalledWith(expect.anything(), 1, 1);
    expect(resolve).toHaveBeenCalledWith(expect.stringMatching(/^secret:backend:/u));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when secure credential storage is unavailable", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    registerInertiaReleaseIpc(
      ipcMain,
      vi.fn<typeof globalThis.fetch>(),
      () => null,
      vi.fn(),
    );

    const handler = handlers.get("inertia:send-discord-release-info");
    await expect(handler?.({} as IpcMainInvokeEvent, {})).rejects.toThrow(
      "Secure credential storage is unavailable",
    );
  });
});
