import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/desktop";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => []),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

describe("preload attachment picker", () => {
  let bridge: DesktopBridge;

  beforeAll(async () => {
    await import("../../src/preload/index");
    bridge = electron.exposeInMainWorld.mock.calls[0]![1] as DesktopBridge;
  });

  it("forwards the image-only authority to the privileged picker", async () => {
    await bridge.selectAttachments("images");
    expect(electron.invoke).toHaveBeenCalledWith(
      "inertia:select-attachments",
      "images",
    );
  });
});
