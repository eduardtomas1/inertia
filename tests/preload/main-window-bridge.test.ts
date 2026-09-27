import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/desktop";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => undefined),
  sendSync: vi.fn(() => true),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    sendSync: electron.sendSync,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

describe("main window preload", () => {
  let bridge: DesktopBridge;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import("../../src/preload/index");
    const exposed = electron.exposeInMainWorld.mock.calls.find(
      ([name]) => name === "inertia",
    );
    bridge = exposed![1] as DesktopBridge;
  });

  it("exposes exactly the workbench desktop capabilities", () => {
    expect(electron.exposeInMainWorld.mock.calls.map(([name]) => name))
      .toEqual(["inertia", "inertiaMascot"]);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual([
      "acknowledgeDetachedChatDraft",
      "approvePrivateConnectPairing",
      "beginAttachmentImport",
      "cancelAppUpdateDownload",
      "cancelAttachmentImport",
      "checkAppUpdate",
      "clearAppCache",
      "clearBackendCredential",
      "commitAttachmentImport",
      "copyDiagnostics",
      "copyRuntimeDiagnosticReport",
      "copyText",
      "createPrivateConnectInvitation",
      "denyPrivateConnectPairing",
      "downloadAppUpdate",
      "exportDiagnostics",
      "exportRecoveryData",
      "finishAttachmentHandoff",
      "focusDetachedChat",
      "getAppHealth",
      "getBackendCredentialState",
      "getCanaryRollbackStatus",
      "getDetachedChatWindows",
      "getPendingDetachedChatDrafts",
      "getPlatform",
      "getPrivateConnectState",
      "getRuntimeConnection",
      "getWindowContext",
      "importAttachments",
      "importRecoveryData",
      "installAppUpdate",
      "onAppUpdateStatus",
      "onDetachedChatDraftChanged",
      "onDetachedChatDraftMirrored",
      "onDetachedChatWindowsChanged",
      "onDiagnosticsChanged",
      "onPreviewState",
      "onPrivateConnectState",
      "onRuntimeReady",
      "onSnapshot",
      "onThreadNotificationActivated",
      "openAttachmentExternally",
      "openCanaryRollback",
      "openDetachedChat",
      "openExternal",
      "openProjectPath",
      "prepareAttachmentHandoff",
      "prepareCanaryRollback",
      "previewClose",
      "previewCommand",
      "previewConnect",
      "previewInspectEvidenceImage",
      "previewNavigate",
      "previewSetBounds",
      "previewTab",
      "queryDiagnostics",
      "releaseAttachment",
      "reportValidationDiagnostic",
      "revealRuntimeLogs",
      "revokePrivateConnectDevice",
      "selectAttachments",
      "selectCodexExecutable",
      "selectDirectory",
      "sendDiscordReleaseInfo",
      "setBackendCredential",
      "setPrivateConnectEnabled",
      "showThreadNotification",
      "snapshot",
      "syncThemePreference",
      "updatePrivateConnectDevice",
    ]);
  });

  it("leaves detached-window controls to the detached chat preload", () => {
    for (const detachedOnly of [
      "setDetachedChatAlwaysOnTop",
      "retargetDetachedChat",
      "dockDetachedChat",
      "closeDetachedChat",
      "persistDetachedChatDraft",
      "mirrorDetachedChatDraft",
    ] satisfies (keyof DesktopBridge)[]) {
      expect(bridge).not.toHaveProperty(detachedOnly);
    }
    expect(electron.sendSync).not.toHaveBeenCalled();
  });
});
