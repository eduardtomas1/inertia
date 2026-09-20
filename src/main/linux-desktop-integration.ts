import type { App } from "electron";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { InertiaReleaseChannelConfiguration } from "./release-channel.js";

const OWNER = "X-Inertia-Managed=true\n";
const MAX_ENTRY_BYTES = 16 * 1024;

function desktopValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
}

/** Desktop Exec quoting is not shell quoting; percent is a field-code escape. */
export function desktopExecutable(path: string): string {
  return desktopValue(`"${path.replaceAll("%", "%%").replace(/["`$\\]/gu, "\\$&")}"`);
}

async function directDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Desktop integration requires direct directories.");
  }
}

async function existingEntry(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_ENTRY_BYTES) throw new Error("Invalid desktop entry.");
    const buffer = Buffer.alloc(MAX_ENTRY_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== metadata.size || bytesRead > MAX_ENTRY_BYTES) throw new Error("Oversized desktop entry.");
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function publishOwnedFile(path: string, bytes: string | Buffer, replace = true): Promise<void> {
  const temporary = join(dirname(path), `.inertia-icon-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    // Both operations publish complete bytes. link refuses an occupied name;
    // rename replaces an owned entry without following a destination symlink.
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Give GNOME a persistent desktop entry/icon instead of a temporary AppDir path. */
export async function integrateLinuxAppImage(options: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appImagePath: string | undefined;
  homeDirectory: string;
  dataHome: string | undefined;
  runtimeIconPath: string;
  configuration: InertiaReleaseChannelConfiguration;
}): Promise<string | null> {
  if (options.platform !== "linux" || !options.isPackaged || !options.appImagePath) return null;
  const requested = options.appImagePath;
  if (!isAbsolute(requested) || requested.length > 4096 || /[\x00-\x1f\x7f]/u.test(requested)) {
    throw new Error("Invalid AppImage desktop path.");
  }
  const executable = await realpath(requested);
  const executableFile = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await executableFile.stat();
    const header = Buffer.alloc(11);
    const { bytesRead } = await executableFile.read(header, 0, header.length, 0);
    if (!metadata.isFile() || !(metadata.mode & 0o111) || bytesRead !== header.length
      || header.toString("hex", 0, 4) !== "7f454c46" || header.toString("hex", 8, 11) !== "414902") {
      throw new Error("The desktop launcher requires an executable type-2 AppImage.");
    }
  } finally {
    await executableFile.close();
  }
  const dataHome = options.dataHome && isAbsolute(options.dataHome)
    ? resolve(options.dataHome) : join(options.homeDirectory, ".local", "share");
  await mkdir(dataHome, { recursive: true, mode: 0o755 });
  // An XDG root may itself be relocated; every child we own stays under its real root.
  const root = await realpath(dataHome);
  const applications = join(root, "applications");
  await directDirectory(applications);
  const config = options.configuration;
  const desktopName = config.desktopName.endsWith(".desktop")
    ? config.desktopName : `${config.desktopName}.desktop`;
  const desktopPath = join(applications, desktopName);
  const previous = await existingEntry(desktopPath);
  if (previous !== null && !previous.endsWith(OWNER)) return null;
  const iconDirectory = join(root, config.appId);
  await directDirectory(iconDirectory);
  const iconPath = join(iconDirectory, "icon.png");
  const sourceIcon = await open(options.runtimeIconPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let icon: Buffer;
  try {
    const metadata = await sourceIcon.stat();
    if (!metadata.isFile() || metadata.size < 8 || metadata.size > 1024 * 1024) {
      throw new Error("Invalid desktop icon.");
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await sourceIcon.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== metadata.size || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
      throw new Error("Invalid desktop icon.");
    }
    icon = bytes.subarray(0, bytesRead);
  } finally {
    await sourceIcon.close();
  }
  await publishOwnedFile(iconPath, icon);
  const entry = `[Desktop Entry]\nType=Application\nName=${desktopValue(config.productName)}\n`
    // GLib checks argv[0] before expanding %% escapes. Keep the AppImage path
    // as an argument so a literal percent in its filename remains launchable.
    + `Exec=/usr/bin/env -- ${desktopExecutable(executable)} %U\nIcon=${desktopValue(iconPath)}\nTerminal=false\n`
    + `StartupWMClass=${config.desktopName.replace(/\.desktop$/u, "")}\nCategories=Development;\n`
    + OWNER;
  if (previous === entry) return desktopPath;
  if (previous === null) {
    // Do not replace a launcher created by another integrator while we prepared the icon.
    await publishOwnedFile(desktopPath, entry, false);
  } else {
    if (await existingEntry(desktopPath) !== previous) throw new Error("The desktop entry changed during integration.");
    await publishOwnedFile(desktopPath, entry);
  }
  return desktopPath;
}

export async function registerLinuxDesktopIcon(
  app: Pick<App, "isPackaged" | "getPath" | "getAppPath">,
  configuration: InertiaReleaseChannelConfiguration,
  runtimeIconPath: string,
): Promise<void> {
  try {
    const desktopPath = await integrateLinuxAppImage({
      platform: process.platform, isPackaged: app.isPackaged,
      appImagePath: process.env.APPIMAGE, homeDirectory: app.getPath("home"),
      dataHome: process.env.NODE_ENV === "test"
        ? join(app.getPath("userData"), "desktop-integration") : process.env.XDG_DATA_HOME,
      runtimeIconPath, configuration,
    });
    if (desktopPath && process.env.APPIMAGE) {
      const icon = join(dirname(dirname(desktopPath)), configuration.appId, "icon.png");
      const file = await realpath(process.env.APPIMAGE);
      // Do not hold first paint on the file manager's optional metadata service.
      void import("./linux-file-icon.js").then(async ({ setLinuxFileIcon }) => {
        // This module is a deferred chunk; its own URL is not the main entry's
        // directory. Resolve the worker from the explicit application layout.
        await setLinuxFileIcon(file, icon, join(app.getAppPath(), "out", "main", "linux-file-icon-worker.js"));
      }).catch(() => undefined);
    }
  } catch {
    console.warn("Unable to register the Inertia desktop icon.");
  }
}
