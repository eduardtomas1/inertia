import { contextBridge, ipcRenderer } from "electron";
import type {
  AppUpdateStatus,
  DesktopBridge,
  PreviewStateUpdate,
  RuntimeConnectionResult,
} from "../shared/desktop.js";
import { PRIVATE_CONNECT_IPC } from "../shared/private-connect/ipc.js";
import { ThreadNotificationActivationBuffer } from "./thread-notification-activation.js";

const IPC = {
  getRuntimeConnection: "inertia:runtime-connection",
  runtimeReady: "inertia:runtime-ready",
  selectDirectory: "inertia:select-directory",
  selectCodexExecutable: "inertia:select-codex-executable",
  exportRecoveryData: "inertia:export-recovery-data",
  importRecoveryData: "inertia:import-recovery-data",
  revealRuntimeLogs: "inertia:reveal-runtime-logs",
  copyRuntimeDiagnosticReport: "inertia:copy-runtime-diagnostic-report",
  copyText: "inertia:copy-text",
  checkAppUpdate: "inertia:check-app-update",
  downloadAppUpdate: "inertia:download-app-update",
  cancelAppUpdateDownload: "inertia:cancel-app-update-download",
  installAppUpdate: "inertia:install-app-update",
  appUpdateStatus: "inertia:app-update-status",
  selectAttachments: "inertia:select-attachments",
  importAttachments: "inertia:import-attachments",
  prepareAttachmentHandoff: "inertia:prepare-attachment-handoff",
  finishAttachmentHandoff: "inertia:finish-attachment-handoff",
  releaseAttachment: "inertia:release-attachment",
  openAttachmentExternally: "inertia:open-attachment-externally",
  openProjectPath: "inertia:open-project-path",
  openExternal: "inertia:open-external",
  showThreadNotification: "inertia:show-thread-notification",
  threadNotificationActivated: "inertia:thread-notification-activated",
  getAppHealth: "inertia:get-app-health",
  clearAppCache: "inertia:clear-app-cache",
  previewNavigate: "inertia:preview-navigate",
  previewCommand: "inertia:preview-command",
  previewSetBounds: "inertia:preview-set-bounds",
  previewClose: "inertia:preview-close",
  previewState: "inertia:preview-state",
  syncThemePreference: "inertia:sync-theme-preference",
  setBackendCredential: "inertia:set-backend-credential",
  clearBackendCredential: "inertia:clear-backend-credential",
  getBackendCredentialState: "inertia:get-backend-credential-state",
} as const;

const threadNotificationActivations = new ThreadNotificationActivationBuffer();
ipcRenderer.on(
  IPC.threadNotificationActivated,
  (_event, conversationId: unknown) => {
    if (typeof conversationId === "string") {
      threadNotificationActivations.receive(conversationId);
    }
  },
);

const bridge: DesktopBridge = Object.freeze({
  getRuntimeConnection: () =>
    ipcRenderer.invoke(IPC.getRuntimeConnection) as Promise<RuntimeConnectionResult>,
  onRuntimeReady: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.runtimeReady, handler);
    return () => ipcRenderer.removeListener(IPC.runtimeReady, handler);
  },
  selectDirectory: () => ipcRenderer.invoke(IPC.selectDirectory) as Promise<string | null>,
  selectCodexExecutable: () => ipcRenderer.invoke(IPC.selectCodexExecutable) as Promise<string | null>,
  exportRecoveryData: () =>
    ipcRenderer.invoke(IPC.exportRecoveryData) as ReturnType<
      DesktopBridge["exportRecoveryData"]
    >,
  importRecoveryData: () =>
    ipcRenderer.invoke(IPC.importRecoveryData) as ReturnType<
      DesktopBridge["importRecoveryData"]
    >,
  revealRuntimeLogs: () => ipcRenderer.invoke(IPC.revealRuntimeLogs) as Promise<string>,
  copyRuntimeDiagnosticReport: () =>
    ipcRenderer.invoke(IPC.copyRuntimeDiagnosticReport) as ReturnType<
      DesktopBridge["copyRuntimeDiagnosticReport"]
    >,
  copyText: (text: string) =>
    ipcRenderer.invoke(IPC.copyText, typeof text === "string" ? text : "") as ReturnType<
      DesktopBridge["copyText"]
    >,
  checkAppUpdate: (force = false) =>
    ipcRenderer.invoke(IPC.checkAppUpdate, force === true) as ReturnType<
      DesktopBridge["checkAppUpdate"]
    >,
  downloadAppUpdate: () =>
    ipcRenderer.invoke(IPC.downloadAppUpdate) as ReturnType<
      DesktopBridge["downloadAppUpdate"]
    >,
  cancelAppUpdateDownload: () =>
    ipcRenderer.invoke(IPC.cancelAppUpdateDownload) as ReturnType<
      DesktopBridge["cancelAppUpdateDownload"]
    >,
  installAppUpdate: () =>
    ipcRenderer.invoke(IPC.installAppUpdate) as ReturnType<
      DesktopBridge["installAppUpdate"]
    >,
  onAppUpdateStatus: (listener: (status: AppUpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) => {
      listener(status);
    };
    ipcRenderer.on(IPC.appUpdateStatus, handler);
    return () => ipcRenderer.removeListener(IPC.appUpdateStatus, handler);
  },
  selectAttachments: (mode: Parameters<DesktopBridge["selectAttachments"]>[0]) => ipcRenderer.invoke(IPC.selectAttachments, mode) as ReturnType<DesktopBridge["selectAttachments"]>,
  importAttachments: (files: Parameters<DesktopBridge["importAttachments"]>[0]) => ipcRenderer.invoke(IPC.importAttachments, files) as ReturnType<DesktopBridge["importAttachments"]>,
  prepareAttachmentHandoff: (request: Parameters<DesktopBridge["prepareAttachmentHandoff"]>[0]) =>
    ipcRenderer.invoke(IPC.prepareAttachmentHandoff, request) as Promise<void>,
  finishAttachmentHandoff: (requestId: string) =>
    ipcRenderer.invoke(IPC.finishAttachmentHandoff, requestId) as Promise<void>,
  releaseAttachment: (id: string) => ipcRenderer.invoke(IPC.releaseAttachment, id) as Promise<void>,
  openAttachmentExternally: (id: string) =>
    ipcRenderer.invoke(IPC.openAttachmentExternally, id) as Promise<void>,
  openProjectPath: (request: Parameters<DesktopBridge["openProjectPath"]>[0]) =>
    ipcRenderer.invoke(IPC.openProjectPath, request) as Promise<string>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  showThreadNotification: (request: Parameters<DesktopBridge["showThreadNotification"]>[0]) =>
    ipcRenderer.invoke(IPC.showThreadNotification, request) as Promise<boolean>,
  onThreadNotificationActivated: (listener: (conversationId: string) => void) =>
    threadNotificationActivations.subscribe(listener),
  getAppHealth: () =>
    ipcRenderer.invoke(IPC.getAppHealth) as ReturnType<DesktopBridge["getAppHealth"]>,
  clearAppCache: () =>
    ipcRenderer.invoke(IPC.clearAppCache) as ReturnType<DesktopBridge["clearAppCache"]>,
  previewNavigate: (request: Parameters<DesktopBridge["previewNavigate"]>[0]) =>
    ipcRenderer.invoke(IPC.previewNavigate, request) as ReturnType<
      DesktopBridge["previewNavigate"]
    >,
  previewCommand: (request: Parameters<DesktopBridge["previewCommand"]>[0]) =>
    ipcRenderer.invoke(IPC.previewCommand, request) as ReturnType<
      DesktopBridge["previewCommand"]
    >,
  previewSetBounds: (request: Parameters<DesktopBridge["previewSetBounds"]>[0]) =>
    ipcRenderer.invoke(IPC.previewSetBounds, request) as Promise<void>,
  previewClose: (request: Parameters<DesktopBridge["previewClose"]>[0]) =>
    ipcRenderer.invoke(IPC.previewClose, request) as Promise<void>,
  onPreviewState: (listener: (state: PreviewStateUpdate) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: PreviewStateUpdate) => {
      listener(state);
    };
    ipcRenderer.on(IPC.previewState, handler);
    return () => ipcRenderer.removeListener(IPC.previewState, handler);
  },
  syncThemePreference: (preference: Parameters<DesktopBridge["syncThemePreference"]>[0]) => ipcRenderer.invoke(IPC.syncThemePreference, preference) as Promise<void>,
  setBackendCredential: (request: Parameters<DesktopBridge["setBackendCredential"]>[0]) =>
    ipcRenderer.invoke(IPC.setBackendCredential, request) as ReturnType<DesktopBridge["setBackendCredential"]>,
  clearBackendCredential: (request: Parameters<DesktopBridge["clearBackendCredential"]>[0]) =>
    ipcRenderer.invoke(IPC.clearBackendCredential, request) as ReturnType<DesktopBridge["clearBackendCredential"]>,
  getBackendCredentialState: (request: Parameters<DesktopBridge["getBackendCredentialState"]>[0]) =>
    ipcRenderer.invoke(IPC.getBackendCredentialState, request) as ReturnType<DesktopBridge["getBackendCredentialState"]>,
  getPrivateConnectState: () =>
    ipcRenderer.invoke(PRIVATE_CONNECT_IPC.getState) as ReturnType<DesktopBridge["getPrivateConnectState"]>,
  onPrivateConnectState: (listener: Parameters<DesktopBridge["onPrivateConnectState"]>[0]) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on(PRIVATE_CONNECT_IPC.stateChanged, handler);
    return () => ipcRenderer.removeListener(PRIVATE_CONNECT_IPC.stateChanged, handler);
  },
  setPrivateConnectEnabled: (request: Parameters<DesktopBridge["setPrivateConnectEnabled"]>[0]) =>
    ipcRenderer.invoke(PRIVATE_CONNECT_IPC.setEnabled, request) as ReturnType<DesktopBridge["setPrivateConnectEnabled"]>,
  createPrivateConnectInvitation: () =>
    ipcRenderer.invoke(PRIVATE_CONNECT_IPC.createInvitation) as ReturnType<DesktopBridge["createPrivateConnectInvitation"]>,
  approvePrivateConnectPairing: (request: Parameters<DesktopBridge["approvePrivateConnectPairing"]>[0]) =>
    ipcRenderer.invoke(PRIVATE_CONNECT_IPC.approvePairing, request) as ReturnType<DesktopBridge["approvePrivateConnectPairing"]>,
  denyPrivateConnectPairing: (requestId: string) =>
    ipcRenderer.invoke(PRIVATE_CONNECT_IPC.denyPairing, requestId) as ReturnType<DesktopBridge["denyPrivateConnectPairing"]>,
  revokePrivateConnectDevice: (deviceId: string) =>
    ipcRenderer.invoke(PRIVATE_CONNECT_IPC.revokeDevice, deviceId) as ReturnType<DesktopBridge["revokePrivateConnectDevice"]>,
  updatePrivateConnectDevice: (request: Parameters<DesktopBridge["updatePrivateConnectDevice"]>[0]) =>
    ipcRenderer.invoke(PRIVATE_CONNECT_IPC.updateDevice, request) as ReturnType<DesktopBridge["updatePrivateConnectDevice"]>,
  getPlatform: () => process.platform,
});

contextBridge.exposeInMainWorld("inertia", bridge);
