import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";

import type { AppControlSettingsRequest, AppControlSettingsState } from "../shared/app-control-settings.js";

/**
 * The App control card's one IPC channel: read the permission state, or open
 * one macOS privacy pane after an explicit click. The renderer names no
 * window, process or URL; the panes are fixed here.
 */

const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  z.object({ type: z.literal("open-settings"), pane: z.enum(["accessibility", "screen-recording"]) }).strict(),
]);

const PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

export interface AppControlIpcOptions {
  ipcMain: { handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void };
  channel: string;
  /** Throws unless the sender is the trusted main window with exactly `expected` arguments. */
  assertTrusted(event: IpcMainInvokeEvent, count: number, expected: number): void;
  service: { settingsState(): Promise<AppControlSettingsState> };
  platform: NodeJS.Platform;
  openExternal(url: string): Promise<void>;
  /** macOS: registers Inertia in the Accessibility list (shows the system prompt once). */
  promptAccessibility(): void;
}

export function parseAppControlSettingsRequest(value: unknown): AppControlSettingsRequest {
  return requestSchema.parse(value);
}

export function registerAppControlIpc(options: AppControlIpcOptions): void {
  options.ipcMain.handle(options.channel, async (event, ...args) => {
    options.assertTrusted(event, args.length, 1);
    const request = parseAppControlSettingsRequest(args[0]);
    if (request.type === "open-settings" && options.platform === "darwin") {
      if (request.pane === "accessibility") options.promptAccessibility();
      await options.openExternal(PANES[request.pane]);
    }
    return await options.service.settingsState();
  });
}
