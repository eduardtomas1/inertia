import { lstatSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app } from "electron";
import { AppUpdateService } from "./app-update.js";
import { loadElectronAppUpdater } from "./electron-app-updater.js";
import type { AppUpdateInstallCoordinator } from "./app-update-install.js";

/** Packaged Linux integration fixture. Only the release download is substituted. */
export function installedUpdateTestFixture() {
  const root = process.env.INERTIA_TEST_INSTALLED_UPDATE;
  if (process.env.NODE_ENV !== "test" || process.platform !== "linux" || !root) return null;
  if (!isAbsolute(root)) throw new Error("Invalid installed update fixture root.");
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Invalid installed update fixture ownership.");
  }
  app.commandLine.appendSwitch("no-sandbox");
  const configuration = JSON.parse(readFileSync(join(root, "update.json"), "utf8")) as {
    candidate: string; version: string;
  };
  const service = new AppUpdateService({
    currentVersion: "0.0.0",
    fetch: async () => { throw new Error("Installed update fixture must not access the release network."); },
    capability: { delivery: "in-app" },
    loadUpdater: async () => {
      const adapter = await loadElectronAppUpdater();
      const namespace = await import("electron-updater");
      const module = namespace.autoUpdater ? namespace : namespace.default;
      module.autoUpdater.checkForUpdates = async () => ({
        isUpdateAvailable: true,
        versionInfo: { version: configuration.version, files: [], releaseDate: new Date().toISOString(), path: "fixture", sha512: "fixture" },
        updateInfo: { version: configuration.version, files: [], releaseDate: new Date().toISOString(), path: "fixture", sha512: "fixture" },
        cancellationToken: new module.CancellationToken(),
      });
      module.autoUpdater.downloadUpdate = async () => [configuration.candidate];
      return adapter;
    },
  });
  return {
    service,
    ready(snapshot: { pid: number | null; websocketUrl: string | null }, coordinator: AppUpdateInstallCoordinator) {
      if (!snapshot.pid || !snapshot.websocketUrl) return;
      const marker = join(root, `ready-${process.pid}.json`);
      if (existsSync(marker)) return;
      writeFileSync(marker, JSON.stringify({ mainPid: process.pid, runtimePid: snapshot.pid,
        websocketUrl: snapshot.websocketUrl, appImage: process.env.APPIMAGE,
        profile: app.getPath("userData"), version: app.getVersion() }), { flag: "wx", mode: 0o600 });
      const timeout = setTimeout(() => app.quit(), 120_000);
      let installing = false;
      const timer = setInterval(() => {
        const command = join(root, `command-${process.pid}`);
        if (!existsSync(command)) return;
        const action = readFileSync(command, "utf8");
        unlinkSync(command);
        if (action === "quit") { clearInterval(timer); clearTimeout(timeout); app.quit(); return; }
        if (installing) return;
        installing = true;
        void (async () => {
          await service.check(true);
          await service.download();
          const result = await coordinator.install();
          writeFileSync(join(root, `result-${process.pid}.json`), JSON.stringify(result), { mode: 0o600 });
        })().catch((error: unknown) => {
          console.error("Installed update fixture failed", error);
          app.quit();
        });
      }, 25);
      timer.unref();
      timeout.unref();
    },
  };
}
