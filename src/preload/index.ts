import { exposeMascotSettings } from "./mascot-settings.js";
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
import { DIAGNOSTICS_IPC } from "../shared/application-diagnostics-ipc.js";
import { DESKTOP_IPC as IPC } from "../shared/desktop-ipc.js";
import { DETACHED_CHAT_IPC } from "../shared/detached-chat-ipc.js";
import { COMPLETION_SOUND_IPC } from "../shared/completion-sound.js";
import { ThreadNotificationActivationBuffer } from "./thread-notification-activation.js";

const threadNotificationActivations = new ThreadNotificationActivationBuffer();
ipcRenderer.on(
  IPC.threadNotificationActivated,
  (_event, conversationId: unknown) => {
    if (typeof conversationId === "string") {
      threadNotificationActivations.receive(conversationId);
    }
  },
);

type PreviewConnectionRequest = Parameters<DesktopBridge["previewConnect"]>[0];
type PreviewBoundsRequest = Parameters<DesktopBridge["previewSetBounds"]>[0];

interface PreviewConnectionState {
  readonly ready: ReturnType<DesktopBridge["previewConnect"]>;
  tail: Promise<void>;
  closed: boolean;
}

const previewConnections = new Map<string, PreviewConnectionState>();

function previewConnectionKey(request: PreviewConnectionRequest): string {
  return `${request.ownerId}:${request.contextId}:${request.connectionId}`;
}

function connectPreview(
  request: PreviewConnectionRequest,
): ReturnType<DesktopBridge["previewConnect"]> {
  const ready = ipcRenderer.invoke(IPC.previewConnect, request) as ReturnType<
    DesktopBridge["previewConnect"]
  >;
  previewConnections.set(previewConnectionKey(request), {
    ready,
    tail: Promise.resolve(),
    closed: false,
  });
  return ready;
}

function setPreviewBounds(request: PreviewBoundsRequest): Promise<void> {
  const state = previewConnections.get(previewConnectionKey(request));
  if (!state || state.closed) return Promise.resolve();
  const operation = state.tail.then(async () => {
    await state.ready;
    if (state.closed) return;
    const accepted = await ipcRenderer.invoke(IPC.previewSetBounds, request) as
      boolean | undefined;
    if (accepted !== false || request.bounds === null || state.closed) return;
    await ipcRenderer.invoke(IPC.previewConnect, {
      ...request, recoverMissingLease: true,
    });
    if (state.closed) return;
    await ipcRenderer.invoke(IPC.previewSetBounds, request);
  });
  state.tail = operation.catch(() => undefined);
  return operation;
}

function closePreview(
  request: Parameters<DesktopBridge["previewClose"]>[0],
): Promise<void> {
  const key = previewConnectionKey(request);
  const state = previewConnections.get(key);
  if (!state) {
    return ipcRenderer.invoke(IPC.previewClose, request).then(() => undefined);
  }
  state.closed = true;
  const operation = state.tail.then(async () => {
    await state.ready.catch(() => undefined);
    await ipcRenderer.invoke(IPC.previewClose, request);
  });
  state.tail = operation.catch(() => undefined);
  return operation.finally(() => {
    if (previewConnections.get(key) === state) previewConnections.delete(key);
  });
}

type MainWindowBridge = Omit<
  DesktopBridge,
  | "setDetachedChatAlwaysOnTop"
  | "retargetDetachedChat"
  | "dockDetachedChat"
  | "closeDetachedChat"
  | "persistDetachedChatDraft"
  | "mirrorDetachedChatDraft"
>;

const bridge: MainWindowBridge = Object.freeze({
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
  queryDiagnostics: (query: Parameters<DesktopBridge["queryDiagnostics"]>[0]) =>
    ipcRenderer.invoke(DIAGNOSTICS_IPC.query, query) as ReturnType<DesktopBridge["queryDiagnostics"]>,
  copyDiagnostics: (query: Parameters<DesktopBridge["copyDiagnostics"]>[0]) =>
    ipcRenderer.invoke(DIAGNOSTICS_IPC.copy, query) as ReturnType<DesktopBridge["copyDiagnostics"]>,
  exportDiagnostics: (query: Parameters<DesktopBridge["exportDiagnostics"]>[0]) =>
    ipcRenderer.invoke(DIAGNOSTICS_IPC.export, query) as ReturnType<DesktopBridge["exportDiagnostics"]>,
  reportValidationDiagnostic: (report: Parameters<DesktopBridge["reportValidationDiagnostic"]>[0]) =>
    ipcRenderer.invoke(DIAGNOSTICS_IPC.reportValidation, report) as ReturnType<DesktopBridge["reportValidationDiagnostic"]>,
  onDiagnosticsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(DIAGNOSTICS_IPC.changed, handler);
    return () => ipcRenderer.removeListener(DIAGNOSTICS_IPC.changed, handler);
  },
  copyRuntimeDiagnosticReport: (
    lifecycle: Parameters<DesktopBridge["copyRuntimeDiagnosticReport"]>[0],
  ) =>
    // Keep the sandboxed preload dependency-free. The trusted main-process IPC
    // boundary performs the strict schema projection before copying anything.
    ipcRenderer.invoke(IPC.copyRuntimeDiagnosticReport, lifecycle) as ReturnType<
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
  snapshot: (request: import("../shared/snapshots").SnapshotRequest) => ipcRenderer.invoke(IPC.snapshot, request),
  onSnapshot: (listener: (delivery: import("../shared/snapshots").SnapshotDelivery) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, delivery: import("../shared/snapshots").SnapshotDelivery): void => listener(delivery);
    ipcRenderer.on(IPC.snapshotReady, handler);
    return () => { ipcRenderer.removeListener(IPC.snapshotReady, handler); };
  },
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
  importCompletionSound: (keep: readonly string[]) =>
    ipcRenderer.invoke(COMPLETION_SOUND_IPC, "import", [...keep]) as ReturnType<DesktopBridge["importCompletionSound"]>,
  readCompletionSound: (file: string) =>
    ipcRenderer.invoke(COMPLETION_SOUND_IPC, "read", file) as ReturnType<DesktopBridge["readCompletionSound"]>,
  removeCompletionSound: (file: string) =>
    ipcRenderer.invoke(COMPLETION_SOUND_IPC, "remove", file) as Promise<void>,
  getAppHealth: () =>
    ipcRenderer.invoke(IPC.getAppHealth) as ReturnType<DesktopBridge["getAppHealth"]>,
  clearAppCache: () =>
    ipcRenderer.invoke(IPC.clearAppCache) as ReturnType<DesktopBridge["clearAppCache"]>,
  previewConnect: connectPreview,
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
  previewSetBounds: setPreviewBounds,
  previewClose: closePreview,
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

exposeMascotSettings();
