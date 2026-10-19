import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { registerAppControlIpc } from "../../src/main/app-control-ipc";
import { parseAppControlSettingsState, type AppControlSettingsState } from "../../src/shared/app-control-settings";

const state: AppControlSettingsState = {
  platform: "darwin", available: true, accessibility: "required", screenRecording: "required", screenshots: "available", session: null,
};

function setup(platform: NodeJS.Platform = "darwin") {
  let handler!: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const options = {
    ipcMain: { handle: vi.fn((_channel: string, listener: typeof handler) => { handler = listener; }) },
    channel: "inertia:app-control",
    assertTrusted: vi.fn((_event: IpcMainInvokeEvent, count: number, expected: number) => {
      if (count !== expected) throw new Error("Rejected untrusted renderer request");
    }),
    service: { settingsState: vi.fn(async () => state) },
    platform,
    openExternal: vi.fn(async () => undefined),
    promptAccessibility: vi.fn(),
  };
  registerAppControlIpc(options);
  const event = {} as IpcMainInvokeEvent;
  return { options, invoke: async (...args: unknown[]) => await handler(event, ...args) };
}

describe("App control IPC", () => {
  it("reads the state for the trusted main window only, with exactly one validated request", async () => {
    const { options, invoke } = setup();
    expect(options.ipcMain.handle).toHaveBeenCalledWith("inertia:app-control", expect.any(Function));
    await expect(invoke({ type: "state" })).resolves.toEqual(state);
    expect(options.assertTrusted).toHaveBeenCalledWith(expect.anything(), 1, 1);
    await expect(invoke()).rejects.toThrow("Rejected");
    await expect(invoke({ type: "state" }, "extra")).rejects.toThrow("Rejected");
    for (const bad of [null, "state", { type: "state", extra: true }, { type: "open-settings", pane: "full-disk" },
      { type: "open-settings", pane: "accessibility", url: "https://example.com" }]) {
      await expect(invoke(bad)).rejects.toThrow();
    }
    expect(options.openExternal).not.toHaveBeenCalled();
    expect(options.promptAccessibility).not.toHaveBeenCalled();
  });

  it("opens only the fixed macOS privacy panes, and only when asked", async () => {
    const { options, invoke } = setup();
    await invoke({ type: "open-settings", pane: "accessibility" });
    expect(options.promptAccessibility).toHaveBeenCalledOnce();
    expect(options.openExternal).toHaveBeenLastCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    await invoke({ type: "open-settings", pane: "screen-recording" });
    expect(options.promptAccessibility).toHaveBeenCalledOnce();
    expect(options.openExternal).toHaveBeenLastCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");

    const linux = setup("linux");
    await expect(linux.invoke({ type: "open-settings", pane: "accessibility" })).resolves.toEqual(state);
    expect(linux.options.openExternal).not.toHaveBeenCalled();
    expect(linux.options.promptAccessibility).not.toHaveBeenCalled();
  });

  it("parses the state strictly where it crosses into the renderer", () => {
    expect(parseAppControlSettingsState(state)).toEqual(state);
    expect(parseAppControlSettingsState({ ...state, session: "x11", platform: "linux", accessibility: "unavailable", screenRecording: "not-needed" }))
      .toMatchObject({ platform: "linux" });
    for (const bad of [null, [], { ...state, extra: 1 }, { ...state, accessibility: "maybe" }, { ...state, available: "yes" },
      { ...state, session: "mir" }, { ...state, screenshots: true }, { ...state, platform: "aix" }]) {
      expect(parseAppControlSettingsState(bad)).toBeNull();
    }
    const { session: _session, ...missing } = state;
    expect(parseAppControlSettingsState(missing)).toBeNull();
  });
});
