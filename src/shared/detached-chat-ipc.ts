import type { DesktopBridge } from "./desktop.js";

export const DETACHED_CHAT_IPC = {
  getWindowContext: "inertia:window-context",
  open: "inertia:detached-chat-open",
  focus: "inertia:detached-chat-focus",
  getWindows: "inertia:detached-chat-windows",
  windowsChanged: "inertia:detached-chat-windows-changed",
  setAlwaysOnTop: "inertia:detached-chat-always-on-top",
  retarget: "inertia:detached-chat-retarget",
  dock: "inertia:detached-chat-dock",
  close: "inertia:detached-chat-close",
} as const;

export type DetachedChatBridge = Pick<
  DesktopBridge,
  | "getWindowContext"
  | "setDetachedChatAlwaysOnTop"
  | "retargetDetachedChat"
  | "dockDetachedChat"
  | "closeDetachedChat"
  | "getRuntimeConnection"
  | "onRuntimeReady"
  | "copyText"
  | "selectAttachments"
  | "importAttachments"
  | "prepareAttachmentHandoff"
  | "finishAttachmentHandoff"
  | "releaseAttachment"
  | "openAttachmentExternally"
  | "openProjectPath"
  | "openExternal"
  | "getPlatform"
>;
