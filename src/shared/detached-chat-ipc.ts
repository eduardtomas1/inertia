import type { DesktopBridge } from "./desktop.js";

export const DETACHED_CHAT_IPC = {
  getWindowContext: "inertia:window-context",
  open: "inertia:detached-chat-open",
  focus: "inertia:detached-chat-focus",
  getWindows: "inertia:detached-chat-windows",
  windowsChanged: "inertia:detached-chat-windows-changed",
  draftChanged: "inertia:detached-chat-draft-changed",
  draftMirrored: "inertia:detached-chat-draft-mirrored",
  getPendingDrafts: "inertia:detached-chat-pending-drafts",
  acknowledgeDraft: "inertia:detached-chat-acknowledge-draft",
  persistDraft: "inertia:detached-chat-persist-draft",
  mirrorDraft: "inertia:detached-chat-mirror-draft",
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
  | "persistDetachedChatDraft"
  | "mirrorDetachedChatDraft"
  | "getRuntimeConnection"
  | "onRuntimeReady"
  | "copyText"
  | "selectAttachments"
  | "beginAttachmentImport"
  | "importAttachments"
  | "commitAttachmentImport"
  | "cancelAttachmentImport"
  | "prepareAttachmentHandoff"
  | "finishAttachmentHandoff"
  | "releaseAttachment"
  | "openAttachmentExternally"
  | "openProjectPath"
  | "openExternal"
  | "getPlatform"
>;
