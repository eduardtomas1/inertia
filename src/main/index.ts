import { constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, join, sep } from "node:path";
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
  protocol,
  safeStorage,
  screen,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
} from "electron";
import {
  parseBackendCredentialProfileRequest,
  parseSetBackendCredentialRequest,
} from "../shared/backend-credentials.js";
import { MAX_CHAT_ATTACHMENTS } from "../shared/attachments.js";
import {
  builtInKimiClaudeBackendProfile,
  KIMI_CLAUDE_BUILTIN_PROFILE_ID,
} from "../shared/claude-backend-profiles.js";
import {
  type AppHealthSnapshot,
  type AppProcessHealth,
  parseDesktopNotificationRequest,
  parseOpenProjectPathRequest,
} from "../shared/desktop.js";
import { safeHttpUrl } from "../shared/preview-url.js";
import { MAC_TRAFFIC_LIGHT_POSITION } from "../shared/window-chrome.js";
import {
  validateSelectedAttachmentCount,
  validateSelectedAttachmentOpen,
  validateSelectedAttachmentRead,
  validateSelectedAttachmentStats,
  type SelectedAttachmentReadSnapshot,
} from "./attachment-import.js";
import {
  AttachmentRegistry,
  createAttachmentStorageSession,
  removeAttachmentStorageSession,
  type AttachmentStorageReservation,
} from "./attachment-registry.js";
import { registerAttachmentLifecycleIpc } from "./attachment-ipc.js";
import {
  closeConversationAttachmentAccess,
  type ConversationAttachmentAccess,
  openPdfAttachment,
  openConversationAttachments,
  resolveAttachmentPreviewResponse,
} from "./conversation-attachment-access.js";
import { AppUpdateService } from "./app-update.js";
import { resolveRuntimeIconPath } from "./runtime-assets.js";
import {
  CredentialVault,
  ElectronSafeStorageBackend,
  FileCredentialVaultPersistence,
  backendSecretReferenceForProfile,
} from "./credential-vault.js";
import { RuntimeDiagnostics, runtimeDiagnosticsDirectory } from "./runtime-diagnostics.js";
import { PreviewBroker, hardenDesktopSession } from "./preview-broker.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";
import * as runtimeBootstrap from "./runtime-bootstrap-safety.js";
import { stopRuntimeAndPrivateConnect } from "./runtime-shutdown-coordination.js";
import { registerClipboardIpc } from "./clipboard-ipc.js";
import { PrivateConnectHost } from "./private-connect/host.js";
import { SecureFileBroker } from "./secure-file-broker.js";
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

const APP_SCHEME = "inertia";
const APP_HOST = "bundle";
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
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
let privateConnectHost: PrivateConnectHost | null = null;
let runtimeDiagnostics: RuntimeDiagnostics | null = null;
let appUpdateService: AppUpdateService | null = null;
let credentialVault: CredentialVault | null = null;
let trustedRendererUrl = "";
let stoppingRuntime = false;
let packageSmokeFilePath: string | null = null;
const PACKAGE_SMOKE_PDF_RESULT_TIMEOUT_MS = 47_000;

async function waitForPackageSmokePdfResult(path: string): Promise<void> {
  const deadline = Date.now() + PACKAGE_SMOKE_PDF_RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        typeof value === "object"
        && value !== null
        && "ok" in value
        && typeof value.ok === "boolean"
        && (
          (value.ok && "content" in value && typeof value.content === "string")
          || (!value.ok && "message" in value && typeof value.message === "string")
        )
      ) return;
      throw new Error("The packaged PDF smoke receipt is invalid.");
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("The packaged PDF smoke receipt was not published before its deadline.");
}
const previewBroker = new PreviewBroker({
  getWindow: () => mainWindow,
  openExternal: async (url) => shell.openExternal(url),
  stateChannel: IPC.previewState,
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }

function windowStatePath(): string { return join(app.getPath("userData"), "window-state.json"); }
function windowAppearancePath(): string { return join(app.getPath("userData"), WINDOW_APPEARANCE_FILENAME); }

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function attachmentStorageRoot(): string {
  return join(app.getPath("temp"), "inertia-attachments");
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
  });
  return importedAttachments;
}

type ElectronAppMetric = ReturnType<typeof app.getAppMetrics>[number];

function processHealth(
  metrics: readonly ElectronAppMetric[],
  pid: number | null,
): AppProcessHealth | null {
  if (pid === null) return null;
  const metric = metrics.find((candidate) => candidate.pid === pid);
  if (!metric) return null;
  return {
    pid,
    cpuPercent: Math.max(0, metric.cpu.percentCPUUsage),
    memoryBytes: Math.max(0, metric.memory.workingSetSize * 1_024),
  };
}

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

async function collectAppHealth(): Promise<AppHealthSnapshot> {
  const metrics = app.getAppMetrics();
  const runtime = runtimeSupervisor?.snapshot() ?? null;
  const rendererPid = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.webContents.getOSProcessId()
    : null;
  const databaseBytes = runtimeDataDirectory
    ? (await Promise.all([
        "inertia.sqlite",
        "inertia.sqlite-wal",
        "inertia.sqlite-shm",
      ].map((name) => fixedRegularFileSize(join(runtimeDataDirectory!, name)))))
        .reduce((total, size) => total + size, 0)
    : 0;
  const cacheBytes = mainWindow && !mainWindow.isDestroyed()
    ? await mainWindow.webContents.session.getCacheSize()
    : 0;
  const attachmentUsage = importedAttachments?.usage()
    ?? attachmentReservation;
  return {
    sampledAt: new Date().toISOString(),
    totalMemoryBytes: metrics.reduce(
      (total, metric) => total + Math.max(
        0,
        metric.memory.workingSetSize * 1_024,
      ),
      0,
    ),
    mainProcess: processHealth(metrics, process.pid),
    rendererProcess: processHealth(metrics, rendererPid),
    runtimeProcess: processHealth(metrics, runtime?.pid ?? null),
    runtimePhase: runtime?.phase ?? "idle",
    databaseBytes,
    cacheBytes,
    temporaryAttachmentBytes: attachmentUsage.bytes,
  };
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
        await registry?.dispose();
        if (directory) await removeAttachmentStorageSession(directory);
      });
  }
  return attachmentCleanup;
}

function registerAppProtocol(): void {
  const rendererRoot = fileURLToPath(new URL("../renderer/", import.meta.url));
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== APP_HOST || url.username || url.password || url.search || url.hash) throw new Error();
      const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      if (requestedPath.includes("\0")) throw new Error();
      const previewId = /^attachment-preview\/([0-9a-f-]{36})$/iu.exec(requestedPath)?.[1];
      if (previewId) {
        const response = await resolveAttachmentPreviewResponse(
          importedAttachments,
          conversationAttachments,
          previewId,
        );
        if (!response) throw new Error();
        return response;
      }
      const target = resolve(rendererRoot, requestedPath);
      if (!isContained(rendererRoot, target)) throw new Error();
      return net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  });
}

function readWindowState(): WindowState {
  try {
    const value = JSON.parse(readFileSync(windowStatePath(), "utf8")) as Partial<WindowState>;
    if (!Number.isInteger(value.width) || !Number.isInteger(value.height)) throw new Error();
    const width = Math.max(760, Math.min(value.width as number, 5000));
    const height = Math.max(600, Math.min(value.height as number, 3000));
    const candidate = Number.isInteger(value.x) && Number.isInteger(value.y) ? { x: value.x as number, y: value.y as number, width, height } : null;
    const visible = candidate && screen.getAllDisplays().some((display) => candidate.x < display.bounds.x + display.bounds.width && candidate.x + candidate.width > display.bounds.x && candidate.y < display.bounds.y + display.bounds.height && candidate.y + candidate.height > display.bounds.y);
    return { ...(visible && candidate ? { x: candidate.x, y: candidate.y } : {}), width, height, maximized: value.maximized === true };
  } catch {
    return { width: 1440, height: 920, maximized: false };
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
    target: `${APP_SCHEME}://${APP_HOST}/index.html`,
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
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function assertTrustedIpc(event: IpcMainInvokeEvent, argumentCount: number, expectedArguments = 0): void {
  const frame = event.senderFrame;

  if (
    argumentCount !== expectedArguments ||
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    !frame ||
    frame !== event.sender.mainFrame ||
    !isTrustedRendererLocation(frame.url)
  ) {
    throw new Error("Rejected untrusted renderer request");
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getRuntimeConnection, (event, ...args) => {
    assertTrustedIpc(event, args.length);

    if (!runtimeSupervisor) {
      throw new Error("The local runtime is not available");
    }

    return runtimeSupervisor.connection();
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

  ipcMain.handle(IPC.copyRuntimeDiagnosticReport, (event, ...args) => {
    assertTrustedIpc(event, args.length);
    const diagnostics = runtimeDiagnostics
      ?? new RuntimeDiagnostics(runtimeDiagnosticsDirectory(app.getPath("userData")));
    runtimeDiagnostics = diagnostics;
    const report = diagnostics.supportReport({
      version: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      runtime: runtimeSupervisor?.snapshot() ?? null,
    });
    clipboard.writeText(report.text);
    diagnostics.record("report.copy");
    return { copied: true, eventCount: report.eventCount };
  });

  registerClipboardIpc(IPC.copyText, assertTrustedIpc);

  ipcMain.handle(IPC.checkAppUpdate, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [force] = args;
    if (typeof force !== "boolean") {
      throw new Error("Invalid update check request");
    }
    if (!appUpdateService) throw new Error("Update checks are unavailable.");
    return await appUpdateService.check(force);
  });

  ipcMain.handle(IPC.selectAttachments, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Attach images or documents",
      buttonLabel: "Attach",
      filters: [{
        name: "Images and safe documents",
        extensions: [
          "png", "jpg", "jpeg", "webp", "gif",
          "pdf", "txt", "md", "markdown", "csv", "json",
        ],
      }],
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    validateSelectedAttachmentCount(result.filePaths.length);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
    const selectedFiles: Array<{
      path: string;
      size: number;
      isFile: boolean;
      snapshot: SelectedAttachmentReadSnapshot;
      file: Awaited<ReturnType<typeof open>>;
    }> = [];
    try {
      for (const path of result.filePaths) {
        const pathInfo = await lstat(path, { bigint: true });
        if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
          throw new Error("The selected attachment is not a safe regular file.");
        }
        const file = await open(
          path,
          constants.O_RDONLY | noFollow | nonBlocking,
        );
        try {
          const info = await file.stat({ bigint: true });
          validateSelectedAttachmentOpen({
            dev: pathInfo.dev,
            ino: pathInfo.ino,
            isFile: pathInfo.isFile(),
            isSymbolicLink: pathInfo.isSymbolicLink(),
          }, {
            dev: info.dev,
            ino: info.ino,
            isFile: info.isFile(),
            isSymbolicLink: info.isSymbolicLink(),
          });
          selectedFiles.push({
            path,
            size: Number(info.size),
            isFile: info.isFile(),
            snapshot: {
              dev: info.dev,
              ino: info.ino,
              size: info.size,
              mtimeNs: info.mtimeNs,
              ctimeNs: info.ctimeNs,
              isFile: info.isFile(),
              isSymbolicLink: info.isSymbolicLink(),
            },
            file,
          });
        } catch (error) {
          await file.close().catch(() => undefined);
          throw error;
        }
      }
      // Validate the complete selection before reading any selected bytes.
      validateSelectedAttachmentStats(selectedFiles.map(({ size, isFile }) => ({
        size,
        isFile,
        isSymbolicLink: false,
      })));
      const values = [];
      for (const selected of selectedFiles) {
        const data = Buffer.alloc(selected.size);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await selected.file.read(
            data,
            offset,
            data.length - offset,
            offset,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const extra = Buffer.alloc(1);
        const { bytesRead: extraBytes } = await selected.file.read(
          extra,
          0,
          1,
          offset,
        );
        if (offset !== data.length || extraBytes !== 0) {
          throw new Error("A selected attachment changed while it was being read.");
        }
        const after = await selected.file.stat({ bigint: true });
        validateSelectedAttachmentRead(selected.snapshot, {
          dev: after.dev,
          ino: after.ino,
          size: after.size,
          mtimeNs: after.mtimeNs,
          ctimeNs: after.ctimeNs,
          isFile: after.isFile(),
          isSymbolicLink: after.isSymbolicLink(),
        });
        values.push({
          name: basename(selected.path),
          mimeType: "",
          data,
        });
      }
      return await attachmentRegistry().import(values);
    } finally {
      await Promise.all(selectedFiles.map(({ file }) =>
        file.close().catch(() => undefined)));
    }
  });

  ipcMain.handle(IPC.importAttachments, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [value] = args;
    if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) {
      throw new Error("Invalid attachments.");
    }
    return await attachmentRegistry().import(value);
  });

  registerAttachmentLifecycleIpc({
    channels: {
      prepare: IPC.prepareAttachmentHandoff,
      finish: IPC.finishAttachmentHandoff,
      release: IPC.releaseAttachment,
    },
    assertTrusted: assertTrustedIpc,
    registry: attachmentRegistry,
    supervisor: () => runtimeSupervisor,
  });

  ipcMain.handle(IPC.openAttachmentExternally, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
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
    assertTrustedIpc(event, args.length, 1);
    const request = parseOpenProjectPathRequest(args[0]);
    if (!request) throw new Error("Invalid project path request");
    if (!runtimeSupervisor) throw new Error("The local runtime is not available");
    const path = await runtimeSupervisor.resolveProjectPath(request);
    if (request.action === "reveal") {
      shell.showItemInFolder(path);
      return "";
    }
    return await shell.openPath(path);
  });

  ipcMain.handle(IPC.openExternal, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [value] = args;
    const url = safeHttpUrl(value);
    await shell.openExternal(url.toString());
  });

  ipcMain.handle(IPC.showThreadNotification, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const request = parseDesktopNotificationRequest(args[0]);
    if (!request) throw new Error("Invalid desktop notification request");
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
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("The app cache is unavailable.");
    }
    await mainWindow.webContents.session.clearCache();
    return await collectAppHealth();
  });

  ipcMain.handle(IPC.previewNavigate, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    return previewBroker.navigate(args[0]);
  });

  ipcMain.handle(IPC.previewCommand, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    return previewBroker.command(args[0]);
  });

  ipcMain.handle(IPC.previewSetBounds, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    previewBroker.setBounds(args[0]);
  });

  ipcMain.handle(IPC.previewClose, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    previewBroker.closeRequest(args[0]);
  });

  ipcMain.handle(IPC.syncThemePreference, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [preference] = args;
    if (!isWindowThemePreference(preference)) throw new Error("Invalid theme preference");
    windowThemePreference = preference;
    nativeTheme.themeSource = preference;
    mainWindow?.setBackgroundColor(resolveWindowBackground(preference, nativeTheme.shouldUseDarkColors));
    try {
      writeWindowThemePreference(windowAppearancePath(), preference);
    } catch {
      // Appearance persistence is best effort; the renderer still applies the
      // active preference immediately and will retry on the next snapshot.
    }
  });

  ipcMain.handle(IPC.setBackendCredential, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const request = parseSetBackendCredentialRequest(args[0]);
    if (!request || !credentialVault) {
      throw new Error("The backend credential request is invalid.");
    }
    return await credentialVault.setForProfile(request.profileId, request.secret);
  });

  ipcMain.handle(IPC.clearBackendCredential, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const request = parseBackendCredentialProfileRequest(args[0]);
    if (!request || !credentialVault) {
      throw new Error("The backend credential request is invalid.");
    }
    return await credentialVault.clearForProfile(request.profileId);
  });

  ipcMain.handle(IPC.getBackendCredentialState, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const request = parseBackendCredentialProfileRequest(args[0]);
    if (!request || !credentialVault) {
      throw new Error("The backend credential request is invalid.");
    }
    return await credentialVault.stateForProfile(request.profileId);
  });
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
  const savedWindow = readWindowState();
  const window = new BrowserWindow({
    title: "Inertia",
    width: savedWindow.width,
    height: savedWindow.height,
    ...(savedWindow.x !== undefined && savedWindow.y !== undefined ? { x: savedWindow.x, y: savedWindow.y } : {}),
    minWidth: 760,
    minHeight: 600,
    show: false,
    backgroundColor: resolveWindowBackground(windowThemePreference, nativeTheme.shouldUseDarkColors),
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
    },
  });

  mainWindow = window;

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
  window.on("close", () => saveWindowState(window));
  window.on("closed", () => {
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
  const windowToClose = mainWindow;
  mainWindow = null;
  if (windowToClose && !windowToClose.isDestroyed()) {
    // Stop renderer polling and release Chromium's final native window before
    // forcing the already-clean main process to exit. Leaving the window alive
    // can keep a packaged process resident after every privileged owner has
    // settled, especially when the runtime-ready bridge is already offline.
    windowToClose.destroy();
  }
  recordPackageSmokeStage("app-exit");
  // The first quit pass already saved window state, closed native previews,
  // stopped the utility runtime, disposed owned attachments, and destroyed the
  // renderer window. Exit directly because Electron's native app-exit path can
  // still block after every privileged resource has already been released.
  process.exit(0);
}

async function bootstrap(): Promise<void> {
  runtimeDiagnostics = new RuntimeDiagnostics(runtimeDiagnosticsDirectory(app.getPath("userData")));
  setImmediate(() => runtimeDiagnostics?.record("app.start"));
  const testUpdateVersion = runtimeBootstrap.runtimeUpdateVersion(app.getVersion());
  appUpdateService = new AppUpdateService({
    currentVersion: app.getVersion(),
    fetch: process.env.NODE_ENV === "test"
      ? async () => new Response(JSON.stringify({
          tag_name: `v${testUpdateVersion.replace(/^v/u, "")}`,
        }))
      : net.fetch as typeof globalThis.fetch,
  });
  nativeTheme.on("updated", () => {
    if (windowThemePreference !== "system") return;
    mainWindow?.setBackgroundColor(
      resolveWindowBackground(windowThemePreference, nativeTheme.shouldUseDarkColors),
    );
  });
  const dataDirectory = runtimeBootstrap.runtimeDataPath(process.env.INERTIA_DATA_DIR, app.getPath("userData"));
  runtimeDataDirectory = dataDirectory;
  const bootstrapSafety = runtimeBootstrap.prepareRuntimeBootstrapSafety(dataDirectory);
  conversationAttachments = openConversationAttachments(dataDirectory);
  const defaultWorkspacePath = runtimeBootstrap.runtimeWorkspacePath(process.env.INERTIA_WORKSPACE_DIR, app.getPath("home"));
  credentialVault = new CredentialVault(
    new ElectronSafeStorageBackend(safeStorage),
    new FileCredentialVaultPersistence(
      join(app.getPath("userData"), "backend-credentials.vault.json"),
    ),
  );

  registerAppProtocol();
  // Paint the secure renderer while private attachment storage is reconciled.
  // The renderer can show its bounded starting state until the runtime-ready
  // signal arrives; orphan cleanup no longer blocks the first window.
  const [, , , attachmentStorage] = await Promise.all([
    createWindow(),
    mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
    mkdir(defaultWorkspacePath, { recursive: true }),
    createAttachmentStorageSession(attachmentStorageRoot(), {
      preserveExisting: bootstrapSafety.preserveAttachments,
    }),
    conversationAttachments,
  ]);
  attachmentStorageDirectory = attachmentStorage.directory;
  const orphanReservation = attachmentStorage.reservation;
  attachmentReservation = orphanReservation;

  packageSmokeFilePath = process.env.NODE_ENV === "test"
    && typeof process.env.INERTIA_PACKAGE_SMOKE_FILE === "string"
    && process.env.INERTIA_PACKAGE_SMOKE_FILE.length <= 4096
    && !process.env.INERTIA_PACKAGE_SMOKE_FILE.includes("\0")
    && isAbsolute(process.env.INERTIA_PACKAGE_SMOKE_FILE)
    ? process.env.INERTIA_PACKAGE_SMOKE_FILE
    : null;
  const packageSmokeCodexExecutable = process.env.NODE_ENV === "test"
    && typeof process.env.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED === "string"
    && process.env.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED.length <= 4096
    && !process.env.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED.includes("\0")
    && isAbsolute(process.env.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED)
    ? process.env.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED
    : null;
  const packageSmokePdfInput = process.env.NODE_ENV === "test"
    && typeof process.env.INERTIA_PACKAGE_SMOKE_PDF_INPUT === "string"
    && process.env.INERTIA_PACKAGE_SMOKE_PDF_INPUT.length <= 4096
    && !process.env.INERTIA_PACKAGE_SMOKE_PDF_INPUT.includes("\0")
    && isAbsolute(process.env.INERTIA_PACKAGE_SMOKE_PDF_INPUT)
    ? process.env.INERTIA_PACKAGE_SMOKE_PDF_INPUT
    : null;
  const packageSmokePdfResult = process.env.NODE_ENV === "test"
    && typeof process.env.INERTIA_PACKAGE_SMOKE_PDF_RESULT === "string"
    && process.env.INERTIA_PACKAGE_SMOKE_PDF_RESULT.length <= 4096
    && !process.env.INERTIA_PACKAGE_SMOKE_PDF_RESULT.includes("\0")
    && isAbsolute(process.env.INERTIA_PACKAGE_SMOKE_PDF_RESULT)
    ? process.env.INERTIA_PACKAGE_SMOKE_PDF_RESULT
    : null;
  let packageSmokeScheduled = false;
  runtimeSupervisor = new RuntimeSupervisor({
    systemBootId: bootstrapSafety.systemBootId,
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
      ...(packageSmokeCodexExecutable ? { codexBinaryPath: packageSmokeCodexExecutable } : {}),
      ...(packageSmokePdfInput && packageSmokePdfResult
        ? {
            packageSmokePdf: {
              inputPath: packageSmokePdfInput,
              resultPath: packageSmokePdfResult,
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
        cwd: app.getPath("home"),
        stdio: "ignore",
        serviceName: "Inertia Runtime",
      },
    ),
    onStateChange: (snapshot) => {
      runtimeDiagnostics?.recordState(snapshot);
      if (
        snapshot.phase === "ready"
        && mainWindow
        && !mainWindow.isDestroyed()
      ) {
        mainWindow.webContents.send(IPC.runtimeReady);
      }
      if (snapshot.phase === "restarting" && snapshot.lastError) {
        console.error("The local runtime stopped; restart scheduled", snapshot.lastError);
      }
      if (snapshot.phase === "stopped") recordPackageSmokeStage("runtime-stopped");
      if (snapshot.phase === "ready" && snapshot.pid && snapshot.websocketUrl && packageSmokeFilePath && !packageSmokeScheduled) {
        packageSmokeScheduled = true;
        void writeFile(
          packageSmokeFilePath,
          JSON.stringify({
            mainPid: process.pid,
            runtimePid: snapshot.pid,
            generation: snapshot.generation,
            websocketUrl: snapshot.websocketUrl,
            timestampMs: Date.now(),
          }),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        ).then(async () => {
          await Promise.all([
            new Promise<void>((resolveWait) => setTimeout(
              resolveWait,
              packageSmokeCodexExecutable ? 10_000 : 100,
            )),
            packageSmokePdfResult
              ? waitForPackageSmokePdfResult(packageSmokePdfResult)
              : Promise.resolve(),
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
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("before-quit", (event) => {
    if (stoppingRuntime) return;

    event.preventDefault();
    stoppingRuntime = true;
    recordPackageSmokeStage("before-quit");
    if (mainWindow) saveWindowState(mainWindow);
    // Native preview WebContentsViews can keep Electron's first quit pass
    // alive even after the supervised runtime has stopped. Destroy them
    // before asynchronous cleanup, rather than waiting for BrowserWindow's
    // `closed` event that this quit sequence itself is trying to reach.
    previewBroker.close();
    const supervisorToStop = runtimeSupervisor;
    runtimeDiagnostics?.record("app.stop");

    void (async () => {
      const privateConnectHostToStop = privateConnectHost;
      privateConnectHost = null;
      const runtimeExitConfirmed = await stopRuntimeAndPrivateConnect(
        async () => {
          if (!supervisorToStop) return true;
          const confirmed = await supervisorToStop.stop().catch((error: unknown) => {
            runtimeDiagnostics?.record("runtime.failure", {
              phase: "stopping",
              message: error instanceof Error ? error.message : "The local runtime could not stop cleanly.",
            });
            console.error("Failed to stop the local runtime", error);
            return false;
          });
          if (confirmed && runtimeSupervisor === supervisorToStop) {
            runtimeSupervisor = null;
          }
          return confirmed;
        },
        async () => {
          await privateConnectHostToStop?.shutdown().catch(() => undefined);
        },
      );
      if (runtimeExitConfirmed) {
        await disposeImportedAttachments().catch((error: unknown) => {
          console.error("Failed to remove temporary attachments", error);
        });
      } else {
        console.warn(
          "Retaining temporary attachments because runtime process exit was not confirmed; startup cleanup will remove them.",
        );
      }
      const retainedAttachments = conversationAttachments;
      conversationAttachments = null;
      await closeConversationAttachmentAccess(retainedAttachments);
    })().then(finishQuitAfterCleanup, (error: unknown) => {
      console.error("Failed to finish privileged shutdown", error); });
  });

  void app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      runtimeDiagnostics?.record("runtime.failure", {
        phase: "starting",
        message: error instanceof Error ? error.message : "Inertia could not start.",
      });
      console.error("Failed to start Inertia", error);
      dialog.showErrorBox(
        "Inertia could not start",
        "The local workspace runtime failed to start. Please reopen Inertia and try again.",
      );
      app.quit();
    });
}

function recordPackageSmokeStage(stage: string): void {
  if (!packageSmokeFilePath) return;
  try {
    writeFileSync(`${packageSmokeFilePath}.${stage}.json`, JSON.stringify({
      stage,
      pid: process.pid,
      timestampMs: Date.now(),
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // Packaged smoke diagnostics are best effort and test-only.
  }
}
