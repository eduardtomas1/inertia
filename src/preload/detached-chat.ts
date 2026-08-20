import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBridge,
  RuntimeConnection,
} from "../shared/desktop.js";
import {
  type DetachedChatBridge,
} from "../shared/detached-chat-ipc.js";

const IPC = {
  getRuntimeConnection: "inertia:runtime-connection",
  runtimeReady: "inertia:runtime-ready",
  copyText: "inertia:copy-text",
  selectAttachments: "inertia:select-attachments",
  importAttachments: "inertia:import-attachments",
  prepareAttachmentHandoff: "inertia:prepare-attachment-handoff",
  finishAttachmentHandoff: "inertia:finish-attachment-handoff",
  releaseAttachment: "inertia:release-attachment",
  openAttachmentExternally: "inertia:open-attachment-externally",
  openProjectPath: "inertia:open-project-path",
  openExternal: "inertia:open-external",
} as const;
// Keep preload entry points self-contained: sandboxed Electron preloads cannot
// require Rollup's relative shared chunks at runtime.
const DETACHED_CHAT_IPC = {
  getWindowContext: "inertia:window-context",
  setAlwaysOnTop: "inertia:detached-chat-always-on-top",
  retarget: "inertia:detached-chat-retarget",
  dock: "inertia:detached-chat-dock",
  close: "inertia:detached-chat-close",
} as const;

const bridge = Object.freeze({
  getWindowContext: () =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.getWindowContext) as ReturnType<
      DesktopBridge["getWindowContext"]
    >,
  setDetachedChatAlwaysOnTop: (alwaysOnTop: boolean) =>
    ipcRenderer.invoke(
      DETACHED_CHAT_IPC.setAlwaysOnTop,
      alwaysOnTop === true,
    ) as ReturnType<DesktopBridge["setDetachedChatAlwaysOnTop"]>,
  retargetDetachedChat: (
    request: Parameters<DesktopBridge["retargetDetachedChat"]>[0],
  ) => ipcRenderer.invoke(
    DETACHED_CHAT_IPC.retarget,
    request,
  ) as ReturnType<DesktopBridge["retargetDetachedChat"]>,
  dockDetachedChat: () =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.dock) as ReturnType<
      DesktopBridge["dockDetachedChat"]
    >,
  closeDetachedChat: () =>
    ipcRenderer.invoke(DETACHED_CHAT_IPC.close) as ReturnType<
      DesktopBridge["closeDetachedChat"]
    >,
  getRuntimeConnection: () =>
    ipcRenderer.invoke(IPC.getRuntimeConnection) as Promise<RuntimeConnection>,
  onRuntimeReady: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.runtimeReady, handler);
    return () => ipcRenderer.removeListener(IPC.runtimeReady, handler);
  },
  copyText: (text: string) =>
    ipcRenderer.invoke(
      IPC.copyText,
      typeof text === "string" ? text : "",
    ) as ReturnType<DesktopBridge["copyText"]>,
  selectAttachments: (
    mode: Parameters<DesktopBridge["selectAttachments"]>[0],
  ) => ipcRenderer.invoke(
    IPC.selectAttachments,
    mode,
  ) as ReturnType<DesktopBridge["selectAttachments"]>,
  importAttachments: (
    files: Parameters<DesktopBridge["importAttachments"]>[0],
  ) => ipcRenderer.invoke(
    IPC.importAttachments,
    files,
  ) as ReturnType<DesktopBridge["importAttachments"]>,
  prepareAttachmentHandoff: (
    request: Parameters<DesktopBridge["prepareAttachmentHandoff"]>[0],
  ) => ipcRenderer.invoke(
    IPC.prepareAttachmentHandoff,
    request,
  ) as ReturnType<DesktopBridge["prepareAttachmentHandoff"]>,
  finishAttachmentHandoff: (requestId: string) =>
    ipcRenderer.invoke(
      IPC.finishAttachmentHandoff,
      requestId,
    ) as ReturnType<DesktopBridge["finishAttachmentHandoff"]>,
  releaseAttachment: (id: string) =>
    ipcRenderer.invoke(
      IPC.releaseAttachment,
      id,
    ) as ReturnType<DesktopBridge["releaseAttachment"]>,
  openAttachmentExternally: (id: string) =>
    ipcRenderer.invoke(
      IPC.openAttachmentExternally,
      id,
    ) as ReturnType<DesktopBridge["openAttachmentExternally"]>,
  openProjectPath: (
    request: Parameters<DesktopBridge["openProjectPath"]>[0],
  ) => ipcRenderer.invoke(
    IPC.openProjectPath,
    request,
  ) as ReturnType<DesktopBridge["openProjectPath"]>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(
      IPC.openExternal,
      url,
    ) as ReturnType<DesktopBridge["openExternal"]>,
  getPlatform: () => process.platform,
} satisfies DetachedChatBridge);

contextBridge.exposeInMainWorld("inertia", bridge);
