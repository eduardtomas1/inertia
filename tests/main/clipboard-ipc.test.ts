import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronFixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("electron", () => ({
  clipboard: { writeText: electronFixture.writeText },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => { electronFixture.handlers.set(channel, handler); },
  },
}));

import { registerClipboardIpc } from "../../src/main/clipboard-ipc";

beforeEach(() => {
  electronFixture.handlers.clear();
  electronFixture.writeText.mockReset();
});

describe("clipboard IPC", () => {
  it("confirms the copy only after Electron finishes the asynchronous write", async () => {
    let finishWrite: (() => void) | undefined;
    electronFixture.writeText.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const assertTrusted = vi.fn();
    registerClipboardIpc("copy", assertTrusted);

    const result = electronFixture.handlers.get("copy")!({} as IpcMainInvokeEvent, "copy me");
    let settled = false;
    void Promise.resolve(result).then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(electronFixture.writeText).toHaveBeenCalledWith("copy me");
    finishWrite!();
    await expect(result).resolves.toBe(true);
    expect(assertTrusted).toHaveBeenCalledWith(expect.anything(), 1, 1);
  });
});
