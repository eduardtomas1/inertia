import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { getPath: () => "/tmp", getAppMetrics: () => [] },
  nativeImage: { createFromBuffer: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => false), getMediaAccessStatus: vi.fn(() => "denied") },
  utilityProcess: { fork: vi.fn() },
}));
vi.mock("electron", () => electron);

import { cleanupWithAppControl, createAppControlMain } from "../../src/main/app-control-main";
import { DESKTOP_IPC } from "../../src/shared/desktop-ipc";

describe("App control main wiring", () => {
  it("registers the card's channel and asks macOS for its Accessibility prompt only from the button", async () => {
    const appControl = createAppControlMain();
    let handler!: (event: unknown, ...args: unknown[]) => Promise<unknown>;
    const ipcMain = { handle: vi.fn((_channel: string, listener: typeof handler) => { handler = listener; }) };
    appControl.registerIpc({ ipcMain, assertTrusted: vi.fn() });
    expect(ipcMain.handle).toHaveBeenCalledWith(DESKTOP_IPC.appControl, expect.any(Function));
    await handler({}, { type: "state" });
    expect(electron.systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
    if (process.platform === "darwin") {
      await handler({}, { type: "open-settings", pane: "accessibility" });
      expect(electron.systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
    }
    await appControl.broker.dispose();
  });

  it("confirms cleanup only when App control and the remaining owners both stopped", async () => {
    const stopped = { broker: { dispose: vi.fn(async () => undefined) } } as never;
    const stuck = { broker: { dispose: vi.fn(async () => { throw new Error("unconfirmed"); }) } } as never;
    await expect(cleanupWithAppControl(stopped, async () => true)).resolves.toBe(true);
    await expect(cleanupWithAppControl(stopped, async () => false)).resolves.toBe(false);
    await expect(cleanupWithAppControl(stuck, async () => true)).resolves.toBe(false);
  });
});
