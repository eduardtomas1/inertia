import { contextBridge, ipcRenderer } from "electron";
import type {
  AppUpdateStatus,
  DesktopBridge,
  DetachedChatDraftHandoff,
  DetachedChatWindowSummary,
  PendingDetachedChatDraft,
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
  getCanaryRollbackStatus: "inertia:get-canary-rollback-status",
  prepareCanaryRollback: "inertia:prepare-canary-rollback",
  openCanaryRollback: "inertia:open-canary-rollback",
  sendDiscordReleaseInfo: "inertia:send-discord-release-info",
  selectAttachments: "inertia:select-attachments",
  beginAttachmentImport: "inertia:begin-attachment-import",
  importAttachments: "inertia:import-attachments",
  commitAttachmentImport: "inertia:commit-attachment-import",
  cancelAttachmentImport: "inertia:cancel-attachment-import",
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
  previewConnect: "inertia:preview-connect",
  previewNavigate: "inertia:preview-navigate",
  previewCommand: "inertia:preview-command",
  previewTab: "inertia:preview-tab",
  previewSetBounds: "inertia:preview-set-bounds",
  previewClose: "inertia:preview-close",
  previewInspectEvidenceImage: "inertia:preview-inspect-evidence-image",
  previewState: "inertia:preview-state",
  syncThemePreference: "inertia:sync-theme-preference",
  setBackendCredential: "inertia:set-backend-credential",
  clearBackendCredential: "inertia:clear-backend-credential",
  getBackendCredentialState: "inertia:get-backend-credential-state",
} as const;
const DETACHED_CHAT_IPC = {
  getWindowContext: "inertia:window-context",
  open: "inertia:detached-chat-open",
  focus: "inertia:detached-chat-focus",
  getWindows: "inertia:detached-chat-windows",
  getPendingDrafts: "inertia:detached-chat-pending-drafts",
  acknowledgeDraft: "inertia:detached-chat-acknowledge-draft",
  windowsChanged: "inertia:detached-chat-windows-changed",
  draftChanged: "inertia:detached-chat-draft-changed",
  draftMirrored: "inertia:detached-chat-draft-mirrored",
  persistDraft: "inertia:detached-chat-persist-draft",
  mirrorDraft: "inertia:detached-chat-mirror-draft",
  setAlwaysOnTop: "inertia:detached-chat-always-on-top",
  retarget: "inertia:detached-chat-retarget",
  dock: "inertia:detached-chat-dock",
  close: "inertia:detached-chat-close",
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
  getWindowContext: () =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.getWindowContext) as ReturnType<
      DesktopBridge["getWindowContext"]
    >,
  openDetachedChat: (
    request: Parameters<DesktopBridge["openDetachedChat"]>[0],
  ) =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.open, request) as ReturnType<
      DesktopBridge["openDetachedChat"]
    >,
  focusDetachedChat: (conversationId: string) =>
    ipcRenderer.invoke(
      DETACHED_CHAT_IPC.focus,
      conversationId,
    ) as ReturnType<DesktopBridge["focusDetachedChat"]>,
  getDetachedChatWindows: () =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.getWindows) as ReturnType<
      DesktopBridge["getDetachedChatWindows"]
    >,
  getPendingDetachedChatDrafts: () =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.getPendingDrafts) as ReturnType<
      DesktopBridge["getPendingDetachedChatDrafts"]
    >,
  acknowledgeDetachedChatDraft: (
    request: Parameters<DesktopBridge["acknowledgeDetachedChatDraft"]>[0],
  ) =>
    ipcRenderer.invoke(
      DETACHED_CHAT_IPC.acknowledgeDraft,
      request,
    ) as ReturnType<DesktopBridge["acknowledgeDetachedChatDraft"]>,
  onDetachedChatWindowsChanged: (
    listener: Parameters<DesktopBridge["onDetachedChatWindowsChanged"]>[0],
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      windows: DetachedChatWindowSummary[],
    ) => listener(windows);
    ipcRenderer.on(DETACHED_CHAT_IPC.windowsChanged, handler);
    return () => ipcRenderer.removeListener(
      DETACHED_CHAT_IPC.windowsChanged,
      handler,
    );
  },
  onDetachedChatDraftChanged: (
    listener: Parameters<DesktopBridge["onDetachedChatDraftChanged"]>[0],
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      handoff: PendingDetachedChatDraft,
    ) => listener(handoff);
    ipcRenderer.on(DETACHED_CHAT_IPC.draftChanged, handler);
    return () => ipcRenderer.removeListener(
      DETACHED_CHAT_IPC.draftChanged,
      handler,
    );
  },
  onDetachedChatDraftMirrored: (
    listener: Parameters<DesktopBridge["onDetachedChatDraftMirrored"]>[0],
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      handoff: DetachedChatDraftHandoff,
    ) => listener(handoff);
    ipcRenderer.on(DETACHED_CHAT_IPC.draftMirrored, handler);
    return () => ipcRenderer.removeListener(
      DETACHED_CHAT_IPC.draftMirrored,
      handler,
    );
  },
  setDetachedChatAlwaysOnTop: (alwaysOnTop: boolean) =>
    ipcRenderer.invoke(
      DETACHED_CHAT_IPC.setAlwaysOnTop,
      alwaysOnTop,
    ) as ReturnType<DesktopBridge["setDetachedChatAlwaysOnTop"]>,
  retargetDetachedChat: (
    request: Parameters<DesktopBridge["retargetDetachedChat"]>[0],
  ) =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.retarget, request) as ReturnType<
      DesktopBridge["retargetDetachedChat"]
    >,
  dockDetachedChat: (draft: string) =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.dock, draft) as ReturnType<
      DesktopBridge["dockDetachedChat"]
    >,
  closeDetachedChat: (draft: string) =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.close, draft) as ReturnType<
      DesktopBridge["closeDetachedChat"]
    >,
  persistDetachedChatDraft: (draft: string) => {
    return ipcRenderer.sendSync(DETACHED_CHAT_IPC.persistDraft, draft) === true;
  },
  mirrorDetachedChatDraft: (draft: string) => {
    return ipcRenderer.sendSync(DETACHED_CHAT_IPC.mirrorDraft, draft) === true;
  },
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
  getCanaryRollbackStatus: () =>
    ipcRenderer.invoke(IPC.getCanaryRollbackStatus) as ReturnType<
      DesktopBridge["getCanaryRollbackStatus"]
    >,
  prepareCanaryRollback: () =>
    ipcRenderer.invoke(IPC.prepareCanaryRollback) as ReturnType<
      DesktopBridge["prepareCanaryRollback"]
    >,
  openCanaryRollback: () =>
    ipcRenderer.invoke(IPC.openCanaryRollback) as ReturnType<
      DesktopBridge["openCanaryRollback"]
    >,
  onAppUpdateStatus: (listener: (status: AppUpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) => {
      listener(status);
    };
    ipcRenderer.on(IPC.appUpdateStatus, handler);
    return () => ipcRenderer.removeListener(IPC.appUpdateStatus, handler);
  },
  sendDiscordReleaseInfo: (
    request: Parameters<DesktopBridge["sendDiscordReleaseInfo"]>[0],
  ) =>
    ipcRenderer.invoke(IPC.sendDiscordReleaseInfo, request) as ReturnType<
      DesktopBridge["sendDiscordReleaseInfo"]
    >,
  selectAttachments: (mode: Parameters<DesktopBridge["selectAttachments"]>[0]) => ipcRenderer.invoke(IPC.selectAttachments, mode) as ReturnType<DesktopBridge["selectAttachments"]>,
  beginAttachmentImport: () => ipcRenderer.invoke(IPC.beginAttachmentImport) as ReturnType<DesktopBridge["beginAttachmentImport"]>,
  importAttachments: (batchId: string, files: Parameters<DesktopBridge["importAttachments"]>[1]) => ipcRenderer.invoke(IPC.importAttachments, batchId, files) as ReturnType<DesktopBridge["importAttachments"]>,
  commitAttachmentImport: (batchId: string, adoptedAttachmentIds: string[]) => ipcRenderer.invoke(IPC.commitAttachmentImport, batchId, adoptedAttachmentIds) as ReturnType<DesktopBridge["commitAttachmentImport"]>,
  cancelAttachmentImport: (batchId: string) => ipcRenderer.invoke(IPC.cancelAttachmentImport, batchId) as ReturnType<DesktopBridge["cancelAttachmentImport"]>,
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
  previewConnect: (request: Parameters<DesktopBridge["previewConnect"]>[0]) =>
    ipcRenderer.invoke(IPC.previewConnect, request) as ReturnType<
      DesktopBridge["previewConnect"]
    >,
  previewNavigate: (request: Parameters<DesktopBridge["previewNavigate"]>[0]) =>
    ipcRenderer.invoke(IPC.previewNavigate, request) as ReturnType<
      DesktopBridge["previewNavigate"]
    >,
  previewCommand: (request: Parameters<DesktopBridge["previewCommand"]>[0]) =>
    ipcRenderer.invoke(IPC.previewCommand, request) as ReturnType<
      DesktopBridge["previewCommand"]
    >,
  previewTab: (request: Parameters<DesktopBridge["previewTab"]>[0]) =>
    ipcRenderer.invoke(IPC.previewTab, request) as ReturnType<
      DesktopBridge["previewTab"]
    >,
  previewSetBounds: async (request: Parameters<DesktopBridge["previewSetBounds"]>[0]) => {
    const accepted = await ipcRenderer.invoke(IPC.previewSetBounds, request) as
      boolean | undefined;
    if (accepted !== false) return;
    await ipcRenderer.invoke(IPC.previewConnect, {
      ...request, recoverMissingLease: true,
    });
    await ipcRenderer.invoke(IPC.previewSetBounds, request);
  },
  previewClose: (request: Parameters<DesktopBridge["previewClose"]>[0]) =>
    ipcRenderer.invoke(IPC.previewClose, request) as Promise<void>,
  previewInspectEvidenceImage: (
    request: Parameters<DesktopBridge["previewInspectEvidenceImage"]>[0],
  ) => ipcRenderer.invoke(IPC.previewInspectEvidenceImage, request) as ReturnType<
    DesktopBridge["previewInspectEvidenceImage"]
  >,
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
