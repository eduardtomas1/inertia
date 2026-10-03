import { join } from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, SaveDialogOptions, SaveDialogReturnValue } from "electron";
import { DIAGNOSTICS_IPC } from "../shared/application-diagnostics-ipc.js";
import { registerApplicationDiagnosticsIpc } from "./application-diagnostics-ipc.js";
import { readDiagnosticsPreferences, writeDiagnosticsPreferences } from "./diagnostics-preferences.js";
import { registerLifecycleSupportReportIpc, type CopyLifecycleSupportReportInput } from "./lifecycle-support-report.js";
import { RuntimeDiagnostics, runtimeDiagnosticsDirectory } from "./runtime-diagnostics.js";

export function openRuntimeDiagnostics(userDataDirectory: string): RuntimeDiagnostics {
  const capture = readDiagnosticsPreferences(userDataDirectory);
  return new RuntimeDiagnostics(runtimeDiagnosticsDirectory(userDataDirectory), capture ? { capture } : {});
}

export interface DiagnosticsMainIpcOptions {
  ipcMain: IpcMain;
  assertTrusted: (event: IpcMainInvokeEvent, received: number, expected?: number) => void;
  diagnostics: () => RuntimeDiagnostics;
  userDataDirectory: string;
  documentsDirectory: () => string;
  mainWindow: () => BrowserWindow | null;
  revealChannel: string;
  supportReportChannel: string;
  supportReportInput: () => Omit<CopyLifecycleSupportReportInput, "lifecycleInput" | "diagnostics">;
  writeClipboard: (text: string) => void | Promise<void>;
  openPath: (path: string) => Promise<string>;
  showSaveDialog: (window: BrowserWindow, options: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  revealsHostFolder: boolean;
}

export function registerDiagnosticsMainIpc(options: DiagnosticsMainIpcOptions): void {
  let observed: RuntimeDiagnostics | null = null;
  const diagnostics = (): RuntimeDiagnostics => {
    const current = options.diagnostics();
    if (observed !== current) {
      observed = current;
      current.onIncidentsChanged(() => {
        const window = options.mainWindow();
        if (window && !window.isDestroyed()) window.webContents.send(DIAGNOSTICS_IPC.changed);
      });
    }
    return current;
  };
  registerApplicationDiagnosticsIpc({
    ipcMain: options.ipcMain, assertTrusted: options.assertTrusted, diagnostics,
    copyText: options.writeClipboard,
    persistCapture: (state) => writeDiagnosticsPreferences(options.userDataDirectory, state),
    chooseExportPath: async () => {
      const window = options.mainWindow();
      if (!window || window.isDestroyed()) throw new Error("The diagnostics window is unavailable.");
      const result = await options.showSaveDialog(window, {
        title: "Export filtered diagnostics",
        defaultPath: join(options.documentsDirectory(), `inertia-diagnostics-${new Date().toISOString().slice(0, 10)}.json`),
        buttonLabel: "Export diagnostics", filters: [{ name: "JSON", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return result.canceled ? null : result.filePath ?? null;
    },
  });
  options.ipcMain.handle(options.revealChannel, async (event, ...args) => {
    options.assertTrusted(event, args.length);
    const current = diagnostics();
    const directory = current.ensureDirectory();
    current.record("logs.reveal");
    if (!options.revealsHostFolder) return "";
    return await options.openPath(directory);
  });
  registerLifecycleSupportReportIpc({
    ipcMain: options.ipcMain, channel: options.supportReportChannel, assertTrustedIpc: options.assertTrusted,
    createInput: () => ({ ...options.supportReportInput(), diagnostics: diagnostics() }),
  });
}
