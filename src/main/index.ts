import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  net,
  nativeTheme,
  protocol,
  screen,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
} from "electron";
import { MAC_TRAFFIC_LIGHT_POSITION } from "../shared/window-chrome.js";
import { resolveRuntimeIconPath } from "./runtime-assets.js";
import { RuntimeDiagnostics, runtimeDiagnosticsDirectory } from "./runtime-diagnostics.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";
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
  selectDirectory: "inertia:select-directory",
  selectCodexExecutable: "inertia:select-codex-executable",
  revealRuntimeLogs: "inertia:reveal-runtime-logs",
  selectAttachments: "inertia:select-attachments",
  importAttachments: "inertia:import-attachments",
  openPath: "inertia:open-path",
  openExternal: "inertia:open-external",
  previewNavigate: "inertia:preview-navigate",
  previewCommand: "inertia:preview-command",
  previewSetBounds: "inertia:preview-set-bounds",
  previewClose: "inertia:preview-close",
  syncThemePreference: "inertia:sync-theme-preference",
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
let runtimeSupervisor: RuntimeSupervisor | null = null;
let runtimeDiagnostics: RuntimeDiagnostics | null = null;
let trustedRendererUrl = "";
let stoppingRuntime = false;
let packageSmokeFilePath: string | null = null;
let previewView: WebContentsView | null = null;
let previewBounds: Electron.Rectangle | null = null;
let windowThemePreference: WindowThemePreference = "system";

interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }

function windowStatePath(): string { return join(app.getPath("userData"), "window-state.json"); }
function windowAppearancePath(): string { return join(app.getPath("userData"), WINDOW_APPEARANCE_FILENAME); }

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function registerAppProtocol(): void {
  const rendererRoot = fileURLToPath(new URL("../renderer/", import.meta.url));
  protocol.handle(APP_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== APP_HOST || url.username || url.password || url.search || url.hash) throw new Error();
      const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      if (requestedPath.includes("\0")) throw new Error();
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

async function cleanupImportedAttachments(): Promise<void> {
  const directory = join(app.getPath("temp"), "inertia-attachments");
  try {
    const entries = await readdir(directory);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    await Promise.all(entries.filter((name) => /^[0-9a-f-]{36}\.(?:png|jpg|webp|gif)$/u.test(name)).map(async (name) => {
      const path = join(directory, name);
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
    }));
  } catch {
    // The temporary attachment directory may not exist yet.
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function safeHttpUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("Invalid URL");
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Only safe HTTP and HTTPS URLs can be opened");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Remote previews must use HTTPS");
  }
  return url;
}

function hasExpectedImageSignature(bytes: Buffer, mimeType: keyof typeof IMAGE_EXTENSIONS): boolean {
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif") return bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a");
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

function previewState(): { url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean } {
  const contents = previewView?.webContents;
  return {
    url: contents?.getURL() ?? "",
    loading: contents?.isLoading() ?? false,
    canGoBack: contents?.navigationHistory.canGoBack() ?? false,
    canGoForward: contents?.navigationHistory.canGoForward() ?? false,
  };
}

function closePreview(): void {
  const view = previewView;
  previewView = null;
  if (!view) return;
  mainWindow?.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

function ensurePreview(): WebContentsView {
  if (previewView) return previewView;
  if (!mainWindow) throw new Error("The preview window is unavailable");
  const view = new WebContentsView({ webPreferences: { partition: "inertia-preview", contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  view.setBackgroundColor("#17171b");
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event, url) => { try { safeHttpUrl(url); } catch { event.preventDefault(); } });
  view.webContents.session.setPermissionCheckHandler(() => false);
  view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  view.webContents.session.on("will-download", (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  mainWindow.contentView.addChildView(view);
  previewView = view;
  if (previewBounds) view.setBounds(previewBounds);
  return view;
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

  ipcMain.handle(IPC.selectAttachments, async (event, ...args) => {
    assertTrustedIpc(event, args.length);
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Attach images",
      buttonLabel: "Attach",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    const mimeByExtension = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    } as const;
    return result.filePaths.slice(0, 8).flatMap((path) => {
      const extension = path.split(".").pop()?.toLowerCase() as keyof typeof mimeByExtension | undefined;
      const mimeType = extension ? mimeByExtension[extension] : undefined;
      if (!mimeType) return [];
      try {
        const size = statSync(path).size;
        if (size < 1 || size > 10 * 1024 * 1024) return [];
        return [{ id: randomUUID(), name: path.split(/[\\/]/).pop() ?? "image", path, mimeType, size }];
      } catch {
        return [];
      }
    });
  });

  ipcMain.handle(IPC.importAttachments, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [value] = args;
    if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid attachments");
    const directory = join(app.getPath("temp"), "inertia-attachments");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const attachments = [];
    for (const candidate of value) {
      if (typeof candidate !== "object" || candidate === null) throw new Error("Invalid attachment");
      const item = candidate as { name?: unknown; mimeType?: unknown; data?: unknown };
      const mimeType = typeof item.mimeType === "string" && item.mimeType in IMAGE_EXTENSIONS ? item.mimeType as keyof typeof IMAGE_EXTENSIONS : undefined;
      const extension = mimeType ? IMAGE_EXTENSIONS[mimeType] : undefined;
      const bytes = item.data instanceof ArrayBuffer ? Buffer.from(item.data) : ArrayBuffer.isView(item.data) ? Buffer.from(item.data.buffer, item.data.byteOffset, item.data.byteLength) : null;
      if (!mimeType || !extension || !bytes || bytes.length < 1 || bytes.length > 10 * 1024 * 1024 || !hasExpectedImageSignature(bytes, mimeType)) throw new Error("Invalid attachment");
      const id = randomUUID();
      const path = join(directory, `${id}.${extension}`);
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      const name = typeof item.name === "string" && item.name.trim() && item.name.length <= 255 ? item.name.trim() : `image.${extension}`;
      attachments.push({ id, name, path, mimeType, size: bytes.length });
    }
    return attachments;
  });

  ipcMain.handle(IPC.openPath, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [path] = args;
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0")) {
      throw new Error("Invalid path");
    }
    return await shell.openPath(resolve(path));
  });

  ipcMain.handle(IPC.openExternal, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [value] = args;
    const url = safeHttpUrl(value);
    await shell.openExternal(url.toString());
  });

  ipcMain.handle(IPC.previewNavigate, async (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const url = safeHttpUrl(args[0]);
    const view = ensurePreview();
    await view.webContents.loadURL(url.toString());
    return previewState();
  });

  ipcMain.handle(IPC.previewCommand, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [action] = args;
    const contents = previewView?.webContents;
    if (!contents || (action !== "back" && action !== "forward" && action !== "reload")) return previewState();
    if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === "reload") contents.reload();
    return previewState();
  });

  ipcMain.handle(IPC.previewSetBounds, (event, ...args) => {
    assertTrustedIpc(event, args.length, 1);
    const [value] = args;
    if (value === null) {
      previewBounds = { x: 0, y: 0, width: 0, height: 0 };
      previewView?.setBounds(previewBounds);
      return;
    }
    if (typeof value !== "object" || !value) throw new Error("Invalid preview bounds");
    const candidate = value as Partial<Electron.Rectangle>;
    if (![candidate.x, candidate.y, candidate.width, candidate.height].every((entry) => Number.isInteger(entry))) throw new Error("Invalid preview bounds");
    const content = mainWindow?.getContentBounds();
    if (!content) return;
    const x = Math.max(0, Math.min(candidate.x as number, content.width));
    const y = Math.max(0, Math.min(candidate.y as number, content.height));
    previewBounds = { x, y, width: Math.max(0, Math.min(candidate.width as number, content.width - x)), height: Math.max(0, Math.min(candidate.height as number, content.height - y)) };
    previewView?.setBounds(previewBounds);
  });

  ipcMain.handle(IPC.previewClose, (event, ...args) => {
    assertTrustedIpc(event, args.length);
    closePreview();
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
}

async function createWindow(): Promise<void> {
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
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  window.once("ready-to-show", () => window.show());
  window.on("close", () => saveWindowState(window));
  window.on("closed", () => {
    closePreview();
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

function focusMainWindow(): void {
  if (!mainWindow) {
    if (app.isReady()) {
      void createWindow();
    }
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function finishQuitAfterCleanup(): void {
  recordPackageSmokeStage("app-exit");
  // `stoppingRuntime` lets this second quit pass through before-quit after the
  // owned runtime has settled, preserving Electron's normal shutdown sequence.
  app.quit();
}

async function bootstrap(): Promise<void> {
  runtimeDiagnostics = new RuntimeDiagnostics(runtimeDiagnosticsDirectory(app.getPath("userData")));
  runtimeDiagnostics.record("app.start");
  nativeTheme.on("updated", () => {
    if (windowThemePreference !== "system") return;
    mainWindow?.setBackgroundColor(
      resolveWindowBackground(windowThemePreference, nativeTheme.shouldUseDarkColors),
    );
  });
  const dataDirectory = process.env.INERTIA_DATA_DIR
    ? resolve(process.env.INERTIA_DATA_DIR)
    : join(app.getPath("userData"), "runtime");
  const defaultWorkspacePath = process.env.INERTIA_WORKSPACE_DIR
    ? resolve(process.env.INERTIA_WORKSPACE_DIR)
    : join(app.getPath("home"), "Inertia");

  await Promise.all([
    mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
    mkdir(defaultWorkspacePath, { recursive: true }),
    cleanupImportedAttachments(),
  ]);

  registerAppProtocol();
  packageSmokeFilePath = process.env.NODE_ENV === "test"
    && typeof process.env.INERTIA_PACKAGE_SMOKE_FILE === "string"
    && process.env.INERTIA_PACKAGE_SMOKE_FILE.length <= 4096
    && !process.env.INERTIA_PACKAGE_SMOKE_FILE.includes("\0")
    && isAbsolute(process.env.INERTIA_PACKAGE_SMOKE_FILE)
    ? process.env.INERTIA_PACKAGE_SMOKE_FILE
    : null;
  let packageSmokeScheduled = false;
  runtimeSupervisor = new RuntimeSupervisor({
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath,
      enableProviders: process.env.NODE_ENV !== "test" || Boolean(process.env.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED),
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
      if (snapshot.phase === "restarting" && snapshot.lastError) {
        console.error("The local runtime stopped; restart scheduled", snapshot.lastError);
      }
      if (snapshot.phase === "stopped") recordPackageSmokeStage("runtime-stopped");
      if (snapshot.phase === "ready" && snapshot.pid && snapshot.websocketUrl && packageSmokeFilePath && !packageSmokeScheduled) {
        packageSmokeScheduled = true;
        void writeFile(
          packageSmokeFilePath,
          JSON.stringify({ mainPid: process.pid, runtimePid: snapshot.pid, generation: snapshot.generation, websocketUrl: snapshot.websocketUrl }),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        ).finally(() => setTimeout(
          () => app.quit(),
          process.env.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED ? 10_000 : 100,
        ));
      }
    },
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
        quit: () => {
          const snapshot = runtimeSupervisor?.snapshot() ?? null;
          setTimeout(() => app.quit(), 100);
          return snapshot;
        },
      }),
    });
  }
  await createWindow();
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
    if (!runtimeSupervisor || stoppingRuntime) {
      return;
    }

    event.preventDefault();
    stoppingRuntime = true;
    recordPackageSmokeStage("before-quit");
    if (mainWindow) saveWindowState(mainWindow);
    const supervisorToStop = runtimeSupervisor;
    runtimeSupervisor = null;
    runtimeDiagnostics?.record("app.stop");

    void supervisorToStop
      .stop()
      .catch((error: unknown) => {
        runtimeDiagnostics?.record("runtime.failure", {
          phase: "stopping",
          message: error instanceof Error ? error.message : "The local runtime could not stop cleanly.",
        });
        console.error("Failed to stop the local runtime", error);
      })
      .finally(finishQuitAfterCleanup);
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
    writeFileSync(`${packageSmokeFilePath}.${stage}.json`, JSON.stringify({ stage, pid: process.pid }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // Packaged smoke diagnostics are best effort and test-only.
  }
}
