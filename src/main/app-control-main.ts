import { shell, systemPreferences } from "electron";

import { DESKTOP_IPC } from "../shared/desktop-ipc.js";
import { registerAppControlIpc, type AppControlIpcOptions } from "./app-control-ipc.js";
import { createAppControlService, type AppControlService } from "./app-control-service.js";

/**
 * Main-process wiring of native App control, kept out of `index.ts`: the one
 * App control service (the runtime reaches it only through its broker), the
 * App control card's IPC channel, and its part of privileged cleanup.
 */

export interface AppControlMain {
  /** The service the runtime supervisor brokers App control requests to. */
  readonly broker: AppControlService;
  registerIpc(options: Pick<AppControlIpcOptions, "ipcMain" | "assertTrusted">): void;
}

export function createAppControlMain(): AppControlMain {
  const service = createAppControlService();
  return {
    broker: service,
    registerIpc: ({ ipcMain, assertTrusted }) => registerAppControlIpc({
      ipcMain,
      channel: DESKTOP_IPC.appControl,
      assertTrusted,
      service,
      platform: process.platform,
      openExternal: async (url) => { await shell.openExternal(url); },
      // Asks macOS to show its Accessibility prompt, which also lists Inertia in the pane.
      promptAccessibility: () => { systemPreferences.isTrustedAccessibilityClient(true); },
    }),
  };
}

/**
 * Stops App control alongside the remaining privileged owners; confirmed only
 * when both are.
 */
export async function cleanupWithAppControl(
  appControl: AppControlMain,
  cleanupRemainingOwners: () => Promise<boolean>,
): Promise<boolean> {
  const stopped = appControl.broker.dispose().then(() => true, () => false);
  const remainingConfirmed = await cleanupRemainingOwners();
  return await stopped && remainingConfirmed;
}
