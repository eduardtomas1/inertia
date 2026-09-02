import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
} from "electron";
import {
  builtInKimiClaudeBackendProfile,
  KIMI_CLAUDE_BUILTIN_PROFILE_ID,
} from "../shared/claude-backend-profiles.js";
import {
  type AppHealthSnapshot,
  parseAttachmentPickerMode, parseDesktopNotificationRequest,
  parseOpenProjectPathRequest,
  type RuntimeConnectionUnavailable,
} from "../shared/desktop.js";
import { PREVIEW_AGENT_INPUT_REFUSAL_CHANNEL } from "../shared/preview-agent-privacy-guard.js";
import { safeHttpUrl } from "../shared/preview-url.js";
import { MAC_TRAFFIC_LIGHT_POSITION } from "../shared/window-chrome.js";
import {
  attachmentPickerConfiguration,
} from "./attachment-import.js";
import { attachmentImportRunner } from "./attachment-import-desktop-runner.js";
import {
  attachmentImportDocumentFromEvent,
  registerRendererAttachmentImportIpc,
  RendererAttachmentImportCoordinator,
} from "./attachment-import-ipc.js";
import {
  importSelectedAttachmentPaths,
  privacySafeAttachmentImportError,
} from "./attachment-selection-import.js";
import {
  AttachmentRegistry,
  createAttachmentStorageSession,
  removeAttachmentStorageSession,
  type AttachmentStorageReservation,
} from "./attachment-registry.js";
import { registerAttachmentLifecycleIpc } from "./attachment-ipc.js";
import { conversationAttachmentStoreRunner } from "./conversation-attachment-store-desktop-runner.js";
import {
  closeConversationAttachmentAccess,
  conversationAttachmentStoreAuthority,
  type ConversationAttachmentAccess,
  openPdfAttachment,
  openConversationAttachments,
} from "./conversation-attachment-access.js";
import { AppUpdateService } from "./app-update.js";
import { AppHealthCollector, InertiaHealthRegistry } from "./app-health.js";
import { registerInertiaReleaseIpc } from "./inertia-release-ipc.js";
import { resolveAppUpdateCapability } from "./app-update-capability.js";
import { AppUpdateInstallCoordinator } from "./app-update-install.js";
import { CanaryRollbackManager } from "./canary-rollback.js";
import { APP_UPDATE_IPC, registerAppUpdateIpc } from "./app-update-ipc.js";
import { initializeReleaseUpdates } from "./release-updates.js";
import { resolveRuntimeIconPath } from "./runtime-assets.js";
import {
  CredentialVault,
  ElectronSafeStorageBackend,
  FileCredentialVaultPersistence,
  backendSecretReferenceForProfile,
} from "./credential-vault.js";
import { RuntimeDiagnostics, runtimeDiagnosticsDirectory } from "./runtime-diagnostics.js";
import { PreviewBroker, hardenDesktopSession } from "./preview-broker.js";
import { showBrowserEvidenceImageWindow } from "./browser-evidence-image-inspector.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";
import { RuntimeSystemSuspendDelivery } from "./runtime-system-suspend-delivery.js";
import { RuntimeSystemSuspendTracker } from "./runtime-system-suspend-tracker.js";
import * as runtimeBootstrap from "./runtime-bootstrap-safety.js";
import { prepareRuntimeBootstrapRecovery } from "./runtime-bootstrap-recovery.js";
import { RuntimeLiveDarwinRecoveryCoordinator } from "./runtime-live-darwin-recovery.js";
import { resolveDesktopRuntimeProcessSafetyAssets } from "./runtime-windows-job-bootstrap.js";
import { disposeWindowsRuntimeJobExecutableLock, prepareWindowsRuntimeJobExecutableLock } from "./windows-runtime-job.js";
import {
  cleanupPrivilegedOwners, finishNormalShutdownAfterCleanup,
  finishPrivilegedExit,
} from "./privileged-shutdown.js";
import { registerClipboardIpc } from "./clipboard-ipc.js";
import { registerCredentialVaultIpc } from "./credential-vault-ipc.js";
import { createDetachedChatMain, type DetachedChatMain } from "./detached-chat-bootstrap.js";
import * as detachedChatClose from "./detached-chat-close-coordinator.js";
import { PrivateConnectHost } from "./private-connect/host.js";
import { SecureFileBroker } from "./secure-file-broker.js";
import { packageSmokeEnvironment } from "./package-smoke-environment.js";
import { waitForRequestedPackageSmokeResults } from "./package-smoke-results.js";
import { APP_HOST, createAppProtocolRegistrar } from "./app-protocol.js";
import { initializeInertiaReleaseChannel, releaseRuntimeOverride } from "./release-channel.js";
import {
  activateThreadNotification,
  waitForThreadNotificationWindowLoad,
} from "./thread-notification-activation.js";
import {
  WINDOW_APPEARANCE_FILENAME,
  isWindowThemePreference,
  readWindowThemePreference,
  resolveWindowBackground,
  type WindowThemePreference,
  writeWindowThemePreference,
} from "./window-appearance.js";
import { MAIN_WINDOW_DEFAULT_STATE, restoreMainWindowState,
  type MainWindowState } from "./main-window-state.js";
import { handleStartupFailure } from "./startup-failure.js";
import { createTestPrivilegedCleanupController } from "./test-privileged-cleanup-controller.js";
const { configuration: releaseChannel, packageSmokeRoot } = initializeInertiaReleaseChannel(app, process.env);
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
  ...APP_UPDATE_IPC,
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
} as const;
protocol.registerSchemesAsPrivileged([
  {
    scheme: releaseChannel.protocolScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
let mainWindow: BrowserWindow | null = null;
let mainWindowCreation: Promise<void> | null = null;
let runtimeSupervisor: RuntimeSupervisor | null = null;
let systemSuspendDelivery: RuntimeSystemSuspendDelivery | null = null;
let privateConnectHost: PrivateConnectHost | null = null;
let runtimeDiagnostics: RuntimeDiagnostics | null = null;
let appUpdateService: AppUpdateService | null = null;
let appUpdateInstallCoordinator: AppUpdateInstallCoordinator | null = null;
let canaryRollbackManager: CanaryRollbackManager | null = null;
let credentialVault: CredentialVault | null = null;
let detachedChatMain: DetachedChatMain | null = null;
let trustedRendererUrl = "";
let privilegedCleanup: Promise<boolean> | null = null;
let packageSmokeFilePath: string | null = null;
let packageSmokeOwnerToken: string | null = null;
const appHealthRegistry = new InertiaHealthRegistry();
appHealthRegistry.registerProcess("main", () => process.pid);
appHealthRegistry.registerProcess(
  "runtime",
  () => runtimeSupervisor?.snapshot().pid ?? null,
);
const previewBroker = new PreviewBroker({
  getWindow: () => mainWindow,
  openExternal: async (url) => shell.openExternal(url),
  stateChannel: IPC.previewState,
  registerHealthRenderer: (contents) => (
    appHealthRegistry.registerRenderer(contents)
  ),
  partitionPrefix: releaseChannel.channel === "canary" ? "inertia-canary-preview" : "inertia-preview",
});
let windowThemePreference: WindowThemePreference = "system";
let importedAttachments: AttachmentRegistry | null = null;
let conversationAttachments: ConversationAttachmentAccess | null = null;
let attachmentCleanup: Promise<void> = Promise.resolve();
let attachmentStorageDirectory: string | null = null;
let runtimeDataDirectory: string | null = null;
let attachmentReservation: AttachmentStorageReservation = {
  records: 0,
  bytes: 0,
};
const registerRendererProtocol = createAppProtocolRegistrar({
  scheme: releaseChannel.protocolScheme,
  attachmentRegistry: () => importedAttachments,
  conversationAttachments: () => conversationAttachments,
  runtimeSupervisor: () => runtimeSupervisor,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function windowStatePath(): string { return join(app.getPath("userData"), "window-state.json"); }
function windowAppearancePath(): string { return join(app.getPath("userData"), WINDOW_APPEARANCE_FILENAME); }

function attachmentStorageRoot(): string {
  return join(app.getPath("temp"), releaseChannel.temporaryAttachmentDirectoryName);
}

function attachmentDirectory(): string {
  if (!attachmentStorageDirectory) {
    throw new Error("Temporary attachment storage is not initialized.");
  }
  return attachmentStorageDirectory;
}

function attachmentRegistry(): AttachmentRegistry {
  importedAttachments ??= new AttachmentRegistry(attachmentDirectory(), {
    reservedRecords: attachmentReservation.records,
    reservedBytes: attachmentReservation.bytes,
    validationRunner: attachmentImportRunner,
    validationDelayMs: process.env.NODE_ENV === "test"
      ? Number(process.env.INERTIA_TEST_ATTACHMENT_IMPORT_DELAY_MS ?? 0)
      : 0,
  });
  return importedAttachments;
}

const rendererAttachmentImports = new RendererAttachmentImportCoordinator(
  attachmentRegistry,
  process.env.NODE_ENV === "test"
    ? Number(process.env.INERTIA_TEST_ATTACHMENT_COMMIT_DELAY_MS ?? 0)
    : 0,
);

async function fixedRegularFileSize(path: string): Promise<number> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink()
      ? metadata.size
      : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

const appHealthCollector = new AppHealthCollector({
  registry: appHealthRegistry,
  getProcessMetrics: () => app.getAppMetrics(),
  getRuntimePhase: () => runtimeSupervisor?.snapshot().phase ?? "idle",
  readDatabaseBytes: async () => runtimeDataDirectory
    ? (await Promise.all([
        "inertia.sqlite",
        "inertia.sqlite-wal",
        "inertia.sqlite-shm",
      ].map((name) => fixedRegularFileSize(join(runtimeDataDirectory!, name)))))
        .reduce((total, size) => total + size, 0)
    : 0,
  readTemporaryAttachmentBytes: () => (
    importedAttachments?.usage() ?? attachmentReservation
  ).bytes,
});

async function collectAppHealth(): Promise<AppHealthSnapshot> {
  return await appHealthCollector.collect();
}

function disposeImportedAttachments(): Promise<void> {
  const registry = importedAttachments;
  const directory = attachmentStorageDirectory;
  importedAttachments = null;
  attachmentStorageDirectory = null;
  if (registry || directory) {
    attachmentCleanup = attachmentCleanup
      .catch(() => undefined)
      .then(async () => {
        await rendererAttachmentImports.dispose();
        await registry?.dispose();
        if (directory) await removeAttachmentStorageSession(directory);
      });
  }
  return attachmentCleanup;
}

function readWindowState(): MainWindowState {
  try {
    return restoreMainWindowState(
      JSON.parse(readFileSync(windowStatePath(), "utf8")),
      screen.getAllDisplays(),
    );
  } catch {
    return { ...MAIN_WINDOW_DEFAULT_STATE };
  }
}

function saveWindowState(window: BrowserWindow): void {
  try {
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    writeFileSync(windowStatePath(), JSON.stringify({ ...bounds, maximized: window.isMaximized() }), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Window-state persistence is best effort and never blocks shutdown.
  }
}

function rendererLocation(): { target: string; isUrl: boolean } {
  const developmentUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

  if (developmentUrl) {
    let parsed: URL;
    try {
      parsed = new URL(developmentUrl);
    } catch {
      throw new Error("Development renderer must use a valid loopback HTTP origin");
    }
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !isLoopback) {
      throw new Error("Development renderer must use a loopback HTTP origin");
    }
    return { target: parsed.href, isUrl: true };
  }

  return {
    target: `${releaseChannel.protocolScheme}://${APP_HOST}/index.html`,
    isUrl: true,
  };
}

function isTrustedRendererLocation(candidate: string): boolean {
  try {
    const actual = new URL(candidate);
    const expected = new URL(trustedRendererUrl);

    return (
      actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search &&
      actual.hash === expected.hash
    );
  } catch {
    return false;
  }
}

function assertTrustedIpc(event: IpcMainInvokeEvent, argumentCount: number, expectedArguments = 0): void {
  if (!detachedChatMain) throw new Error("Rejected untrusted renderer request");
  detachedChatMain.assertMainIpc(event, argumentCount, expectedArguments);
}

function assertTrustedChatIpc(event: IpcMainInvokeEvent, argumentCount: number, expectedArguments = 0) {
  if (!detachedChatMain) throw new Error("Rejected untrusted renderer request");
  return detachedChatMain.assertTrustedChatIpc(event, argumentCount, expectedArguments);
}

function runtimeConnectionUnavailable(message: string): RuntimeConnectionUnavailable {
  return { unavailable: true, message };
}
function isTransientRuntimeConnectionError(error: unknown): error is Error {
  return error instanceof Error && (
    error.message.startsWith("The local service is starting.")
    || error.message.startsWith("The local service is restarting.")
  );
}

function registerIpcHandlers(): void {
  ipcMain.on(PREVIEW_AGENT_INPUT_REFUSAL_CHANNEL, (event, value) => { event.returnValue = previewBroker.reportInputRefusal(event.sender, value); });
  ipcMain.handle(IPC.getRuntimeConnection, (event, ...args) => {
    const context = assertTrustedChatIpc(event, args.length);

    if (!runtimeSupervisor) {
      return runtimeConnectionUnavailable("The local runtime is not available.");
    }

    try {
      return context.role === "main"
        ? runtimeSupervisor.connection(true)
        : runtimeSupervisor.detachedConnection(
            context.conversationId,
            `web-contents:${event.sender.id}`,
          );
    } catch (error) {
      if (isTransientRuntimeConnectionError(error)) {
        return runtimeConnectionUnavailable(error.message);
      }
      throw error;
    }
  });

  ipcMain.handle(IPC.selectDirectory, async (event, ...args) => {
    assertTrustedIpc(event, args.length);

    if (!mainWindow) {
      return null;
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a workspace",
      defaultPath: app.getPath("home"),
      buttonLabel: "Choose workspace",
      properties: ["openDirectory"],
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.selectCodexExecutable, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose the Codex executable",
      defaultPath: app.getPath("home"),
      buttonLabel: "Use Codex executable",
      ...(process.platform === "win32"
        ? { filters: [{ name: "Codex executables", extensions: ["exe", "cmd", "bat", "com"] }] }
        : {}),
      properties: ["openFile"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.exportRecoveryData, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    if (!mainWindow || !runtimeSupervisor) {
      throw new Error("Database recovery export is unavailable.");
    }
    const timestamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export Inertia recovery data",
      defaultPath: join(
        app.getPath("documents"),
        `Inertia recovery ${timestamp}.json`,
      ),
      buttonLabel: "Export recovery file",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) return { status: "cancelled" };
    await runtimeSupervisor.databaseRecovery("export", result.filePath);
    return { status: "exported" };
  });

  ipcMain.handle(IPC.importRecoveryData, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    if (!mainWindow || !runtimeSupervisor) {
      throw new Error("Database recovery import is unavailable.");
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Inertia recovery data",
      defaultPath: app.getPath("documents"),
      buttonLabel: "Import recovery file",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (!path) return { status: "cancelled" };
    const destination = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder for recovered projects",
      defaultPath: app.getPath("documents"),
      buttonLabel: "Authorize recovery folder",
      properties: ["openDirectory", "createDirectory"],
    });
    const targetDirectory = destination.canceled
      ? undefined
      : destination.filePaths[0];
    if (!targetDirectory) return { status: "cancelled" };
    const summary = await runtimeSupervisor.databaseRecovery(
      "import",
      path,
      targetDirectory,
    );
    if (!summary) throw new Error("The recovery import returned no summary.");
    return { status: "imported", summary };
  });

  ipcMain.handle(IPC.revealRuntimeLogs, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    const diagnostics = runtimeDiagnostics
      ?? new RuntimeDiagnostics(runtimeDiagnosticsDirectory(app.getPath("userData")));
    runtimeDiagnostics = diagnostics;
    const directory = diagnostics.ensureDirectory();
    diagnostics.record("logs.reveal");
    // E2E exercises the trusted no-argument bridge without launching a host file
    // manager. Production always asks the OS to reveal this fixed local path.
    if (process.env.NODE_ENV === "test") return "";
    return await shell.openPath(directory);
  });

  ipcMain.handle(IPC.copyRuntimeDiagnosticReport, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    const diagnostics = runtimeDiagnostics
      ?? new RuntimeDiagnostics(runtimeDiagnosticsDirectory(app.getPath("userData")));
    runtimeDiagnostics = diagnostics;
    const report = diagnostics.supportReport({
      version: app.getVersion(),
      channel: releaseChannel.channel,
      platform: process.platform,
      architecture: process.arch,
      runtime: runtimeSupervisor?.snapshot() ?? null,
    });
    await clipboard.writeText(report.text);
    diagnostics.record("report.copy");
    return { copied: true, eventCount: report.eventCount };
  });

  registerInertiaReleaseIpc(
    ipcMain,
    net.fetch as typeof globalThis.fetch,
    () => credentialVault,
    assertTrustedIpc,
  );

  registerClipboardIpc(IPC.copyText, assertTrustedChatIpc);

  registerAppUpdateIpc({
    ipcMain,
    currentVersion: () => app.getVersion(),
    service: () => appUpdateService, installCoordinator: () => appUpdateInstallCoordinator,
    rollbackManager: () => canaryRollbackManager,
    assertTrustedIpc,
  });

  ipcMain.handle(IPC.selectAttachments, async (event, ...args) => {
    if (!detachedChatMain) throw new Error("Rejected untrusted renderer request");
    const ownerWindow = detachedChatMain.windowForTrustedChatIpc(event, args.length, 1);
    const mode = parseAttachmentPickerMode(args[0]);
    if (!mode) throw new Error("Invalid attachment picker mode.");
    const picker = attachmentPickerConfiguration(mode);
    const document = attachmentImportDocumentFromEvent(event);
    const batchId = rendererAttachmentImports.begin(document);
    try {
      const result = await dialog.showOpenDialog(ownerWindow, {
        title: picker.title,
        buttonLabel: "Attach",
        filters: [{
          name: picker.filterName,
          extensions: picker.extensions,
        }],
        properties: ["openFile", "multiSelections"],
      });
      if (result.canceled) {
        await rendererAttachmentImports.cancel(document, batchId);
        return null;
      }
      const attachments = await rendererAttachmentImports.importSelection(
        document,
        batchId,
        async (signal) => await importSelectedAttachmentPaths(
          attachmentRegistry(),
          result.filePaths,
          mode,
          signal,
        ),
      );
      return { batchId, attachments };
    } catch (error) {
      try {
        await rendererAttachmentImports.cancel(document, batchId);
      } catch (cleanupError) {
        throw privacySafeAttachmentImportError(new AggregateError([
          error,
          cleanupError,
        ]));
      }
      throw privacySafeAttachmentImportError(error);
    }
  });

  registerRendererAttachmentImportIpc({
    ipcMain,
    channels: {
      begin: IPC.beginAttachmentImport,
      importOne: IPC.importAttachments,
      commit: IPC.commitAttachmentImport,
      cancel: IPC.cancelAttachmentImport,
    },
    assertTrusted: assertTrustedChatIpc,
    coordinator: rendererAttachmentImports,
    sanitizeError: privacySafeAttachmentImportError,
  });

  registerAttachmentLifecycleIpc({
    channels: {
      prepare: IPC.prepareAttachmentHandoff,
      finish: IPC.finishAttachmentHandoff,
      release: IPC.releaseAttachment,
    },
    assertTrusted: assertTrustedChatIpc,
    registry: attachmentRegistry,
    supervisor: () => runtimeSupervisor,
  });

  ipcMain.handle(IPC.openAttachmentExternally, async (event, ...args) => {
    assertTrustedChatIpc(event, args.length, 1);
    const [value] = args;
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error("Invalid attachment.");
    }
    await openPdfAttachment(
      attachmentRegistry(),
      conversationAttachments,
      value,
    );
  });

  ipcMain.handle(IPC.openProjectPath, async (event, ...args) => {
    const context = assertTrustedChatIpc(event, args.length, 1);
    const request = parseOpenProjectPathRequest(args[0]);
    if (!request) throw new Error("Invalid project path request");
    if (context.role === "detached-chat" && request.conversationId !== context.conversationId) {
      throw new Error("Detached chats can open files only for their owned conversation");
    }
    if (!runtimeSupervisor) throw new Error("The local runtime is not available");
    const path = await runtimeSupervisor.resolveProjectPath(request);
    if (request.action === "reveal") {
      shell.showItemInFolder(path);
      return "";
    }
    return await shell.openPath(path);
  });

  ipcMain.handle(IPC.openExternal, async (event, ...args) => {
    assertTrustedChatIpc(event, args.length, 1);
    const [value] = args;
    const url = safeHttpUrl(value);
    await shell.openExternal(url.toString());
  });

  ipcMain.handle(IPC.showThreadNotification, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const request = parseDesktopNotificationRequest(args[0]);
    if (!request) throw new Error("Invalid desktop notification request");
    if (detachedChatMain?.isFocusedForNotification(request.conversationId)) return false;
    if (!Notification.isSupported()) return false;
    const copy = {
      completed: ["Inertia finished", "A coding task completed."],
      approval: ["Inertia needs approval", "A coding task is waiting for approval."],
      input: ["Inertia needs your input", "A coding task is waiting for your answer."],
      failed: ["Inertia task failed", "A coding task needs attention."],
    } as const;
    const [title, body] = copy[request.kind];
    const notification = new Notification({ title, body });
    notification.once("click", () => {
      if (detachedChatMain?.focusForNotification(request.conversationId)) return;
      void activateThreadNotification(request.conversationId, {
        channel: IPC.threadNotificationActivated,
        currentWindow: () => mainWindow,
        createWindow,
      }).catch((error: unknown) => {
        console.error("Failed to activate a thread notification", error);
      });
    });
    notification.show();
    return true;
  });

  ipcMain.handle(IPC.getAppHealth, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    return await collectAppHealth();
  });
  ipcMain.handle(IPC.clearAppCache, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    return await appHealthCollector.clearCache();
  });
  ipcMain.handle(IPC.previewConnect, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    return previewBroker.connect(args[0]);
  });
  ipcMain.handle(IPC.previewNavigate, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    return previewBroker.navigate(args[0]);
  });
  ipcMain.handle(IPC.previewCommand, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    return await previewBroker.command(args[0]);
  });
  ipcMain.handle(IPC.previewTab, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    return previewBroker.tab(args[0]);
  });
  ipcMain.handle(IPC.previewSetBounds, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    previewBroker.setBounds(args[0]);
  });
  ipcMain.handle(IPC.previewClose, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    previewBroker.closeRequest(args[0]);
  });
  ipcMain.handle(IPC.previewInspectEvidenceImage, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    return await previewBroker.inspectEvidenceImage(args[0], async ({ fingerprint }) => {
      const options = {
        type: "warning" as const,
        title: "Inspect local Browser capture?",
        message: "Inspect this local Browser capture?",
        detail: `Capture ${fingerprint.slice(0, 12)} may contain private information. It stays on this device and is never shared with the agent.`,
        buttons: ["Inspect capture", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const decision = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      return decision.response === 0;
    }, async (image) => await showBrowserEvidenceImageWindow(owner, image));
  });
  ipcMain.handle(IPC.syncThemePreference, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [preference] = args;
    if (!isWindowThemePreference(preference)) throw new Error("Invalid theme preference");
    windowThemePreference = preference;
    nativeTheme.themeSource = preference;
    const backgroundColor = resolveWindowBackground(preference, nativeTheme.shouldUseDarkColors);
    mainWindow?.setBackgroundColor(backgroundColor);
    detachedChatMain?.setBackgroundColor(backgroundColor);
    try {
      writeWindowThemePreference(windowAppearancePath(), preference);
    } catch {
      // Appearance persistence is best effort; the renderer still applies the
      // active preference immediately and will retry on the next snapshot.
    }
  });

  registerCredentialVaultIpc(ipcMain, () => credentialVault, assertTrustedIpc);
}

async function createMainWindow(): Promise<void> {
  const renderer = rendererLocation();
  trustedRendererUrl = renderer.isUrl
    ? new URL(renderer.target).href
    : pathToFileURL(renderer.target).href;

  const iconPath = resolveRuntimeIconPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (!existsSync(iconPath)) throw new Error(`The required Inertia window icon is missing: ${iconPath}`);
  windowThemePreference = readWindowThemePreference(windowAppearancePath());
  nativeTheme.themeSource = windowThemePreference;
  const backgroundColor = resolveWindowBackground(
    windowThemePreference,
    nativeTheme.shouldUseDarkColors,
  );
  detachedChatMain ??= createDetachedChatMain({
    mainWindow: () => mainWindow,
    rendererUrl: trustedRendererUrl, userDataDirectory: app.getPath("userData"),
    iconPath, backgroundColor, productName: releaseChannel.productName,
    applicationScheme: releaseChannel.protocolScheme,
    sessionPartitionPrefix: releaseChannel.channel === "canary" ? "inertia-canary" : "inertia",
    registerRendererProtocol: (session, conversationId) =>
      registerRendererProtocol(session.protocol, conversationId),
    registerHealthRenderer: (contents) => (
      appHealthRegistry.registerRenderer(contents)
    ),
    onDraftStoreDiagnostic: (diagnostic) => runtimeDiagnostics?.record(
      "detached-draft.recovery",
      { ...diagnostic },
    ),
    onDock: (conversationId) => activateThreadNotification(conversationId, {
      channel: IPC.threadNotificationActivated,
      currentWindow: () => mainWindow, createWindow,
    }),
  });
  const savedWindow = readWindowState();
  const window = new BrowserWindow({
    title: releaseChannel.productName,
    width: savedWindow.width,
    height: savedWindow.height,
    ...(savedWindow.x !== undefined && savedWindow.y !== undefined ? { x: savedWindow.x, y: savedWindow.y } : {}),
    minWidth: 760,
    minHeight: 600,
    show: false,
    backgroundColor,
    autoHideMenuBar: true,
    icon: iconPath,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
        }
      : {}),
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      ...(releaseChannel.sessionPartition ? { partition: releaseChannel.sessionPartition } : {}),
    },
  });

  mainWindow = window;
  const unregisterHealthRenderer = appHealthRegistry.registerRenderer(
    window.webContents,
  );
  window.on("page-title-updated", (event) => { event.preventDefault(); window.setTitle(releaseChannel.productName); });
  detachedChatMain.registerIpc();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererLocation(url)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedRendererLocation(url)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) previewBroker.close();
  });
  window.webContents.on("render-process-gone", () => previewBroker.close());
  hardenDesktopSession(window.webContents.session);

  window.once("ready-to-show", () => window.show());
  detachedChatClose.coordinateMainWindowClose(window, detachedChatMain, saveWindowState);
  window.on("closed", () => {
    unregisterHealthRenderer();
    previewBroker.close();
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (savedWindow.maximized) window.maximize();

  if (renderer.isUrl) {
    await window.loadURL(renderer.target);
  } else {
    await window.loadFile(renderer.target);
  }
}

function createWindow(): Promise<void> {
  if (mainWindowCreation) return mainWindowCreation;
  if (mainWindow && !mainWindow.isDestroyed()) {
    return waitForThreadNotificationWindowLoad(mainWindow);
  }
  const creation = createMainWindow();
  mainWindowCreation = creation;
  const clearCreation = (): void => {
    if (mainWindowCreation === creation) mainWindowCreation = null;
  };
  void creation.then(clearCreation, clearCreation);
  return creation;
}

function focusMainWindow(): void {
  if (!app.isReady()) return;
  void createWindow().then(() => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }).catch((error: unknown) => {
    console.error("Failed to focus the Inertia window", error);
  });
}

function finishQuitAfterCleanup(): void {
  finishPrivilegedExit({
    takeWindow: () => { const window = mainWindow; mainWindow = null; return window; },
    recordExit: () => recordPackageSmokeStage("app-exit"), exit: () => process.exit(0),
  });
}
function runPrivilegedCleanup(): Promise<boolean> {
  if (privilegedCleanup) return privilegedCleanup;
  systemSuspendDelivery?.close(); systemSuspendDelivery = null;
  if (mainWindow) saveWindowState(mainWindow);
  const supervisorToStop = runtimeSupervisor, privateConnectHostToStop = privateConnectHost; privateConnectHost = null;
  const cleanup = (async () => { try {
      await detachedChatClose.closeDetachedChatsForShutdown(detachedChatMain);
      previewBroker.close(); runtimeDiagnostics?.record("app.stop");
      return await cleanupPrivilegedOwners({
        runtime: supervisorToStop, privateConnect: privateConnectHostToStop,
        onRuntimeStopped: () => { if (runtimeSupervisor === supervisorToStop) runtimeSupervisor = null; },
        onRuntimeError: (error) => {
          runtimeDiagnostics?.record("runtime.failure", {
            phase: "stopping", message: error instanceof Error
              ? error.message : "The local runtime could not stop cleanly.",
          });
          console.error("Failed to stop the local runtime", error);
        },
        onPrivateConnectError: (error) => console.error("Failed to stop Private Connect cleanly", error),
        disposeTemporaryAttachments: disposeImportedAttachments,
        onTemporaryAttachmentError: (error) => console.error("Failed to remove temporary attachments", error),
        onUnconfirmedRuntimeExit: () => console.warn(
          "Retaining temporary attachments because runtime process exit was not confirmed; startup cleanup will remove them.",
        ),
        closeDurableAttachments: async () => {
          const retainedAttachments = conversationAttachments; conversationAttachments = null;
          await closeConversationAttachmentAccess(retainedAttachments);
        },
      });
    } finally { await disposeWindowsRuntimeJobExecutableLock(); }
  })();
  privilegedCleanup = cleanup; return cleanup;
}
async function bootstrap(): Promise<void> {
  runtimeDiagnostics = new RuntimeDiagnostics(runtimeDiagnosticsDirectory(app.getPath("userData")));
  setImmediate(() => runtimeDiagnostics?.record("app.start"));
  const systemSuspends = new RuntimeSystemSuspendTracker({
    statePath: join(app.getPath("userData"), "runtime-system-suspends.json"),
    recoveredAt: new Date().toISOString(),
    onDiagnostic: (error) => console.error(
      "Unable to retain system suspend accounting.",
      error,
    ),
  });
  const suspendDelivery = new RuntimeSystemSuspendDelivery({
    tracker: systemSuspends,
    runtime: () => runtimeSupervisor,
  });
  systemSuspendDelivery = suspendDelivery;
  const testUpdateVersion = runtimeBootstrap.runtimeUpdateVersion(app.getVersion());
  const appUpdateCapability = process.env.NODE_ENV === "test"
    ? { delivery: "manual" as const, reason: "development-build" as const }
    : resolveAppUpdateCapability({ isPackaged: app.isPackaged,
        platform: process.platform, appPath: app.getAppPath(), appImagePath: process.env.APPIMAGE });
  const releaseUpdates = initializeReleaseUpdates({
    configuration: releaseChannel,
    currentVersion: app.getVersion(),
    capability: appUpdateCapability,
    fetch: net.fetch as typeof globalThis.fetch,
    ...(process.env.NODE_ENV === "test" ? { testUpdateVersion } : {}),
    userDataDirectory: app.getPath("userData"),
    platform: process.platform, architecture: process.arch, activeAppImagePath: process.env.APPIMAGE,
    openPath: async (path) => await shell.openPath(path), revealPath: (path) => shell.showItemInFolder(path),
  });
  appUpdateService = releaseUpdates.service;
  canaryRollbackManager = releaseUpdates.rollbackManager;
  appUpdateService.subscribe((status) => {
    const window = mainWindow;
    if (window && !window.isDestroyed()) window.webContents.send(IPC.appUpdateStatus, status);
  });
  appUpdateInstallCoordinator = new AppUpdateInstallCoordinator({
    service: appUpdateService, runtime: () => runtimeSupervisor,
    privateConnect: () => privateConnectHost, cleanup: runPrivilegedCleanup,
    finishNormalShutdown: finishQuitAfterCleanup,
    onUnconfirmedShutdown: () => console.error("Refusing to exit because privileged shutdown could not be confirmed."),
    reportError: (error) => console.error("Failed to prepare the application update", error),
  });
  nativeTheme.on("updated", () => {
    if (windowThemePreference !== "system") return;
    const backgroundColor = resolveWindowBackground(windowThemePreference, nativeTheme.shouldUseDarkColors);
    mainWindow?.setBackgroundColor(backgroundColor);
    detachedChatMain?.setBackgroundColor(backgroundColor);
  });
  const configuredDataDirectory = releaseRuntimeOverride({ configuration: releaseChannel,
    isPackaged: app.isPackaged, packageSmokeRoot,
    configuredPath: process.env.INERTIA_DATA_DIR, smokeDirectoryName: "data" });
  const dataDirectory = runtimeBootstrap.runtimeDataPath(configuredDataDirectory,
    app.getPath("userData"));
  runtimeDataDirectory = dataDirectory;
  const { runtimeProcessGuardianPath, windowsRuntimeJobAssembly } = resolveDesktopRuntimeProcessSafetyAssets();
  // Prime the verified launch broker before the short recovery deadline.
  if (windowsRuntimeJobAssembly) await prepareWindowsRuntimeJobExecutableLock(windowsRuntimeJobAssembly);
  const {
    bootstrapSafety,
    modernDarwinRecoveryAuthority,
    runtimeRecoveryBlocked,
  } = await prepareRuntimeBootstrapRecovery(dataDirectory, runtimeProcessGuardianPath);
  conversationAttachments = openConversationAttachments(
    dataDirectory,
    conversationAttachmentStoreRunner,
  );
  const retainedConversationAttachments = conversationAttachments;
  const configuredWorkspaceDirectory = releaseRuntimeOverride({
    configuration: releaseChannel, isPackaged: app.isPackaged, packageSmokeRoot,
    configuredPath: process.env.INERTIA_WORKSPACE_DIR, smokeDirectoryName: "workspace",
  });
  const defaultWorkspacePath = runtimeBootstrap.runtimeWorkspacePath(
    configuredWorkspaceDirectory,
    app.getPath("home"),
    releaseChannel.workspaceDirectoryName,
  );
  credentialVault = new CredentialVault(
    new ElectronSafeStorageBackend(safeStorage),
    new FileCredentialVaultPersistence(
      join(app.getPath("userData"), "backend-credentials.vault.json"),
    ),
  );

  registerRendererProtocol(releaseChannel.sessionPartition ? session.fromPartition(releaseChannel.sessionPartition).protocol : undefined);
  // Paint the secure renderer while private attachment storage is reconciled.
  // The renderer can show its bounded starting state until the runtime-ready
  // signal arrives; orphan cleanup no longer blocks the first window.
  const [, , , attachmentStorage, conversationAttachmentStore] = await Promise.all([
    createWindow(),
    mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
    mkdir(defaultWorkspacePath, { recursive: true }),
    createAttachmentStorageSession(attachmentStorageRoot(), {
      preserveExisting: bootstrapSafety.preserveAttachments,
    }),
    retainedConversationAttachments,
  ]);
  attachmentStorageDirectory = attachmentStorage.directory;
  const orphanReservation = attachmentStorage.reservation;
  attachmentReservation = orphanReservation;

  const packageSmoke = packageSmokeEnvironment();
  packageSmokeFilePath = packageSmoke.marker;
  packageSmokeOwnerToken = packageSmoke.ownerToken;
  const {
    codexExecutable: packageSmokeCodexExecutable,
    pdfInput: packageSmokePdfInput,
    pdfResult: packageSmokePdfResult,
    imageInput: packageSmokeImageInput,
    imageResult: packageSmokeImageResult,
  } = packageSmoke;
  let packageSmokeScheduled = false;
  const liveDarwinRecovery = new RuntimeLiveDarwinRecoveryCoordinator({ dataDirectory, systemBootId: bootstrapSafety.systemBootId, guardianPath: runtimeProcessGuardianPath });
  runtimeSupervisor = new RuntimeSupervisor({
    ...(windowsRuntimeJobAssembly ? { windowsRuntimeJobAssembly } : {}),
    agentBrowserBroker: previewBroker,
    getProcessMetrics: () => app.getAppMetrics(),
    systemBootId: bootstrapSafety.systemBootId,
    onSystemSuspendResult: (id, generation, recorded) =>
      suspendDelivery.result(id, generation, recorded),
    runtimeRecoveryBlocked,
    conversationAttachmentStoreRunner,
    conversationAttachmentStoreAuthority:
      await conversationAttachmentStoreAuthority(conversationAttachmentStore),
    attachmentBroker: {
      resolve: (attachmentId, handoffId, signal) =>
        attachmentRegistry().resolveForRuntime(
          attachmentId,
          handoffId,
          signal,
        ),
      release: (attachmentId) =>
        attachmentRegistry().release(attachmentId),
    },
    credentialBroker: {
      resolve: (secretReference) => credentialVault!.resolve(secretReference),
      status: (secretReference) => credentialVault!.status(secretReference),
      clear: (secretReference) => credentialVault!.clear(secretReference),
      forget: (secretReference) => credentialVault!.forget(secretReference),
    },
    secureFileBroker: new SecureFileBroker({
      spawn: (parent) => utilityProcess.fork(
        fileURLToPath(new URL("./secure-file-worker.js", import.meta.url)),
        [],
        {
          cwd: parent,
          env: {},
          stdio: "ignore",
          serviceName: "Inertia Secure File",
        },
      ),
    }),
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath,
      attachmentRoot: attachmentDirectory(),
      enableProviders: process.env.NODE_ENV !== "test" || Boolean(packageSmokeCodexExecutable),
      ...(modernDarwinRecoveryAuthority
        ? { manualModernDarwinRecovery: modernDarwinRecoveryAuthority }
        : {}),
      ...(runtimeProcessGuardianPath ? { runtimeProcessGuardianPath } : {}),
      ...(packageSmokeCodexExecutable ? { codexBinaryPath: packageSmokeCodexExecutable } : {}),
      ...(packageSmokePdfInput && packageSmokePdfResult
        ? {
            packageSmokePdf: {
              inputPath: packageSmokePdfInput,
              resultPath: packageSmokePdfResult,
            },
          }
        : {}),
      ...(packageSmokeImageInput && packageSmokeImageResult
        ? {
            packageSmokeImage: {
              inputPath: packageSmokeImageInput,
              resultPath: packageSmokeImageResult,
            },
          }
        : {}),
      kimiClaudeProfiles: [
        builtInKimiClaudeBackendProfile(
          backendSecretReferenceForProfile(KIMI_CLAUDE_BUILTIN_PROFILE_ID),
        ),
      ],
    },
    spawn: () => utilityProcess.fork(
      fileURLToPath(new URL("./runtime-worker.js", import.meta.url)),
      [],
      {
        cwd: app.getPath("home"), env: runtimeBootstrap.runtimeProcessEnvironment(),
        stdio: "ignore",
        serviceName: "Inertia Runtime",
      },
    ),
    onStateChange: (snapshot) => {
      suspendDelivery.runtimeState(snapshot.phase, snapshot.generation);
      runtimeDiagnostics?.recordState(snapshot);
      if (
        snapshot.phase === "ready"
        && mainWindow
        && !mainWindow.isDestroyed()
      ) {
        mainWindow.webContents.send(IPC.runtimeReady);
        detachedChatMain?.sendToDetached(IPC.runtimeReady);
      }
      if (snapshot.phase === "restarting" && snapshot.lastError) {
        console.error("The local runtime stopped; restart scheduled", snapshot.lastError);
      }
      if (snapshot.phase === "stopped") recordPackageSmokeStage("runtime-stopped");
      liveDarwinRecovery.observe(snapshot, runtimeSupervisor);
      if (snapshot.phase === "ready" && snapshot.pid && snapshot.websocketUrl && packageSmokeFilePath && packageSmokeOwnerToken && !packageSmokeScheduled) {
        packageSmokeScheduled = true;
        void writeFile(
          packageSmokeFilePath,
          JSON.stringify({
            mainPid: process.pid,
            runtimePid: snapshot.pid,
            generation: snapshot.generation,
            websocketUrl: snapshot.websocketUrl,
            timestampMs: Date.now(),
            ownerToken: packageSmokeOwnerToken,
          }),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        ).then(async () => {
          await Promise.all([
            new Promise<void>((resolveWait) => setTimeout(
              resolveWait,
              packageSmokeCodexExecutable ? 10_000 : 100,
            )),
            waitForRequestedPackageSmokeResults({
              pdf: packageSmokePdfResult,
              image: packageSmokeImageResult,
            }),
          ]);
        }).catch(() => undefined).finally(() => app.quit());
      }
    },
  });
  privateConnectHost = PrivateConnectHost.create({
    userDataDirectory: app.getPath("userData"),
    staticRoot: join(app.getAppPath(), "out", "private-connect"),
    buildVersion: app.getVersion(),
    runtime: runtimeSupervisor,
    window: () => mainWindow,
    assertTrusted: assertTrustedIpc,
  });
  registerIpcHandlers();
  powerMonitor.on("suspend", () => systemSuspends.suspend());
  powerMonitor.on("resume", () => {
    systemSuspends.resume();
    suspendDelivery.sendIfReady();
  });
  runtimeSupervisor.start();
  if (process.env.NODE_ENV === "test") {
    Object.defineProperty(globalThis, "__inertiaTestRuntime", {
      configurable: true,
      value: Object.freeze({
        snapshot: () => runtimeSupervisor?.snapshot() ?? null,
        crash: () => {
          const snapshot = runtimeSupervisor?.snapshot();
          if (!snapshot?.pid) throw new Error("The test runtime is not running");
          process.kill(snapshot.pid, "SIGKILL");
          return snapshot;
        },
        recycle: () => runtimeSupervisor?.testOnlyRecycle()
          ?? Promise.reject(new Error("The test runtime is not running")),
        agentBrowser: (id: string, command: Parameters<PreviewBroker["perform"]>[1]) => previewBroker.perform(id, command),
        ...createTestPrivilegedCleanupController({ runtimePid: () => runtimeSupervisor?.snapshot().pid ?? null,
          cleanup: runPrivilegedCleanup, unconfirmedMessage: () => runtimeSupervisor?.snapshot().lastError ?? null, exit: finishQuitAfterCleanup }),
        quit: () => {
          const snapshot = runtimeSupervisor?.snapshot() ?? null;
          setTimeout(() => app.quit(), 100);
          return snapshot;
        },
      }),
    });
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);
  app.on("activate", focusMainWindow);
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (event) => {
    if (appUpdateInstallCoordinator?.allowBeforeQuit()) return;
    event.preventDefault();
    recordPackageSmokeStage("before-quit");
    if (!appUpdateInstallCoordinator) {
      void runPrivilegedCleanup().then((cleanupConfirmed) => {
        finishNormalShutdownAfterCleanup({ cleanupConfirmed,
          finish: finishQuitAfterCleanup, onUnconfirmed: () => console.error(
            "Refusing to exit because privileged shutdown could not be confirmed."),
        });
      }, (error: unknown) => console.error("Failed to finish privileged shutdown", error));
    }
  });

  void app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      handleStartupFailure(error, {
        environment: process.env,
        recordDiagnostic: (message) => runtimeDiagnostics?.record("runtime.failure", {
          phase: "starting",
          message,
        }),
        logFailure: (failure) => console.error("Failed to start Inertia", failure),
        showErrorBox: (title, content) => dialog.showErrorBox(title, content),
        quit: () => app.quit(),
      });
    });
}
function recordPackageSmokeStage(stage: string): void {
  if (!packageSmokeFilePath) return;
  try {
    writeFileSync(`${packageSmokeFilePath}.${stage}.json`, JSON.stringify({
      stage,
      pid: process.pid,
      timestampMs: Date.now(),
      ownerToken: packageSmokeOwnerToken,
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // Packaged smoke diagnostics are best effort and test-only.
  }
}
