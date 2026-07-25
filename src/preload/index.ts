import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, RuntimeConnection } from "../shared/desktop.js";

const IPC = {
  getRuntimeConnection: "inertia:runtime-connection",
  selectDirectory: "inertia:select-directory",
  selectCodexExecutable: "inertia:select-codex-executable",
  revealRuntimeLogs: "inertia:reveal-runtime-logs",
  selectAttachments: "inertia:select-attachments",
  importAttachments: "inertia:import-attachments",
  openProjectPath: "inertia:open-project-path",
  openExternal: "inertia:open-external",
  previewNavigate: "inertia:preview-navigate",
  previewCommand: "inertia:preview-command",
  previewSetBounds: "inertia:preview-set-bounds",
  previewClose: "inertia:preview-close",
  syncThemePreference: "inertia:sync-theme-preference",
  setBackendCredential: "inertia:set-backend-credential",
  clearBackendCredential: "inertia:clear-backend-credential",
  getBackendCredentialState: "inertia:get-backend-credential-state",
} as const;

const bridge: DesktopBridge = Object.freeze({
  getRuntimeConnection: () =>
    ipcRenderer.invoke(IPC.getRuntimeConnection) as Promise<RuntimeConnection>,
  selectDirectory: () => ipcRenderer.invoke(IPC.selectDirectory) as Promise<string | null>,
  selectCodexExecutable: () => ipcRenderer.invoke(IPC.selectCodexExecutable) as Promise<string | null>,
  revealRuntimeLogs: () => ipcRenderer.invoke(IPC.revealRuntimeLogs) as Promise<string>,
  selectAttachments: () => ipcRenderer.invoke(IPC.selectAttachments) as ReturnType<DesktopBridge["selectAttachments"]>,
  importAttachments: (files: Parameters<DesktopBridge["importAttachments"]>[0]) => ipcRenderer.invoke(IPC.importAttachments, files) as ReturnType<DesktopBridge["importAttachments"]>,
  openProjectPath: (request: Parameters<DesktopBridge["openProjectPath"]>[0]) =>
    ipcRenderer.invoke(IPC.openProjectPath, request) as Promise<string>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  previewNavigate: (url: string) => ipcRenderer.invoke(IPC.previewNavigate, url) as ReturnType<DesktopBridge["previewNavigate"]>,
  previewCommand: (action: "back" | "forward" | "reload") => ipcRenderer.invoke(IPC.previewCommand, action) as ReturnType<DesktopBridge["previewCommand"]>,
  previewSetBounds: (bounds: Parameters<DesktopBridge["previewSetBounds"]>[0]) => ipcRenderer.invoke(IPC.previewSetBounds, bounds) as Promise<void>,
  previewClose: () => ipcRenderer.invoke(IPC.previewClose) as Promise<void>,
  syncThemePreference: (preference: Parameters<DesktopBridge["syncThemePreference"]>[0]) => ipcRenderer.invoke(IPC.syncThemePreference, preference) as Promise<void>,
  setBackendCredential: (request: Parameters<DesktopBridge["setBackendCredential"]>[0]) =>
    ipcRenderer.invoke(IPC.setBackendCredential, request) as ReturnType<DesktopBridge["setBackendCredential"]>,
  clearBackendCredential: (request: Parameters<DesktopBridge["clearBackendCredential"]>[0]) =>
    ipcRenderer.invoke(IPC.clearBackendCredential, request) as ReturnType<DesktopBridge["clearBackendCredential"]>,
  getBackendCredentialState: (request: Parameters<DesktopBridge["getBackendCredentialState"]>[0]) =>
    ipcRenderer.invoke(IPC.getBackendCredentialState, request) as ReturnType<DesktopBridge["getBackendCredentialState"]>,
  getPlatform: () => process.platform,
});

contextBridge.exposeInMainWorld("inertia", bridge);
