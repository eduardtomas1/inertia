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
      "clearDiagnostics",
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
      "importCompletionSound",
      "importRecoveryData",
      "installAppUpdate",
      "onAppUpdateStatus",
      "onDetachedChatDraftChanged",
      "onDetachedChatDraftMirrored",
      "onDetachedChatTerminalHandoff",
      "onDetachedChatWindowsChanged",
      "onDiagnosticsChanged",
      "onLaunchRequest",
      "onMainWindowTarget",
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
      "readCompletionSound",
      "reattachAttachment",
      "releaseAttachment",
      "removeCompletionSound",
      "reportValidationDiagnostic",
      "revealRuntimeLogs",
      "revokePrivateConnectDevice",
      "selectAttachments",
      "selectCodexExecutable",
      "selectDirectory",
      "sendDiscordReleaseInfo",
      "setBackendCredential",
      "setDiagnosticsCapture",
      "setPrivateConnectEnabled",
      "showContextMenu",
      "showThreadNotification",
      "snapshot",
      "syncAppShortcutKeys",
      "syncThemePreference",
      "takeLaunchRequests",
      "updatePrivateConnectDevice",
    ]);
  });

  it("leaves detached-window controls to the detached chat preload", () => {
    for (const detachedOnly of [
      "setDetachedChatAlwaysOnTop",
      "retargetDetachedChat",
      "dockDetachedChat",
      "openInMainWindow",
      "closeDetachedChat",
      "persistDetachedChatDraft",
      "mirrorDetachedChatDraft",
    ] satisfies (keyof DesktopBridge)[]) {
      expect(bridge).not.toHaveProperty(detachedOnly);
    }
    expect(electron.sendSync).not.toHaveBeenCalled();
  });

  it("holds the latest detached-chat target until the workbench subscribes and drops malformed pushes", () => {
    const channel = "inertia:detached-chat-main-window-target";
    const registration = electron.on.mock.calls.find(([name]) => name === channel);
    expect(registration).toBeDefined();
    const push = registration![1] as (event: unknown, value: unknown) => void;
    const sourceConversationId = "11111111-1111-4111-8111-111111111111";
    const older = { sourceConversationId, target: { kind: "settings", page: "agents" } };
    const latest = { sourceConversationId, target: { kind: "usage-limits" } };

    push({}, older);
    push({}, latest);
    push({}, "not a request");
    push({}, null);
    const listener = vi.fn();
    const dispose = bridge.onMainWindowTarget(listener);
    expect(listener.mock.calls).toEqual([[latest]]);

    push({}, older);
    expect(listener.mock.calls).toEqual([[latest], [older]]);
    dispose();
    push({}, latest);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("delivers only exact terminal handoffs to the workbench", () => {
    const channel = "inertia:detached-chat-terminal-handoff";
    const listener = vi.fn();
    const dispose = bridge.onDetachedChatTerminalHandoff(listener);
    const registration = electron.on.mock.calls.find(([name]) => name === channel);
    expect(registration).toBeDefined();
    const push = registration![1] as (event: unknown, value: unknown) => void;
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "22222222-2222-4222-8222-222222222222";
    const handoff = { conversationId, terminalIds: [terminalId], dock: true };

    push({}, handoff);
    push({}, { conversationId, terminalIds: [], dock: false });
    for (const malformed of [
      null,
      "handoff",
      { conversationId, terminalIds: [terminalId] },
      { ...handoff, extra: true },
      { ...handoff, conversationId: "not-a-uuid" },
      { ...handoff, terminalIds: ["not-a-uuid"] },
      { ...handoff, terminalIds: [terminalId, terminalId] },
      { ...handoff, terminalIds: Array.from({ length: 5 }, (_, index) => `2222222${index}-2222-4222-8222-222222222222`) },
      { ...handoff, dock: "yes" },
    ]) push({}, malformed);
    expect(listener.mock.calls).toEqual([
      [handoff],
      [{ conversationId, terminalIds: [], dock: false }],
    ]);
    dispose();
    expect(electron.removeListener).toHaveBeenCalledWith(channel, registration![1]);
  });

  it("forwards only a boolean capture choice and no arguments when clearing diagnostics", async () => {
    await bridge.setDiagnosticsCapture(false);
    await bridge.setDiagnosticsCapture("yes" as unknown as boolean);
    await bridge.clearDiagnostics();
    expect(electron.invoke.mock.calls).toEqual([
      ["inertia:diagnostics-set-capture", false],
      ["inertia:diagnostics-set-capture", false],
      ["inertia:diagnostics-clear"],
    ]);
  });
});
