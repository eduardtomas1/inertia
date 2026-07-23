import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXPECTED_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ROOT = resolve(import.meta.dirname, "..");

function pngDimensions(buffer, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label} is not a valid PNG image.`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findAppImage() {
  const release = join(ROOT, "release");
  const matches = (await readdir(release)).filter((name) => name.endsWith(".AppImage"));
  if (matches.length !== 1) throw new Error(`Expected exactly one AppImage in ${release}; found ${matches.length}.`);
  return join(release, matches[0]);
}

async function extractAppImage(appImage, destination) {
  try {
    await execFileAsync(appImage, ["--appimage-extract"], {
      cwd: destination,
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (appImageError) {
    try {
      await execFileAsync("unsquashfs", ["-f", "-d", join(destination, "squashfs-root"), appImage], {
        cwd: destination,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (unsquashfsError) {
      throw new Error(`Could not extract ${basename(appImage)}: ${appImageError.message}; ${unsquashfsError.message}`);
    }
  }
  const appDir = join(destination, "squashfs-root");
  if (!await exists(appDir)) throw new Error("AppImage extraction did not create squashfs-root.");
  return appDir;
}

function parseDesktopEntry(source) {
  const values = new Map();
  let inDesktopEntry = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^\s*(?:#|$)/u.test(line)) continue;
    if (/^\[.+\]$/u.test(line)) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

async function validateAppDir(appDir) {
  const desktopFiles = (await readdir(appDir)).filter((name) => name.endsWith(".desktop"));
  if (desktopFiles.length !== 1) throw new Error(`Expected one embedded desktop entry; found ${desktopFiles.length}.`);
  const desktopPath = join(appDir, desktopFiles[0]);
  const desktop = parseDesktopEntry(await readFile(desktopPath, "utf8"));
  const expectedDesktop = {
    Name: "Inertia",
    Icon: "inertia",
    StartupWMClass: "Inertia",
  };
  for (const [field, expected] of Object.entries(expectedDesktop)) {
    if (desktop.get(field) !== expected) throw new Error(`Desktop ${field} must be ${JSON.stringify(expected)}; received ${JSON.stringify(desktop.get(field))}.`);
  }
  const desktopExec = desktop.get("Exec") ?? "";
  if (!/^(?:inertia|AppRun)(?:\s|$)/u.test(desktopExec)) throw new Error(`Desktop Exec must launch the packaged Inertia entry point; received ${JSON.stringify(desktopExec)}.`);
  const entryPoint = desktopExec.startsWith("AppRun") ? join(appDir, "AppRun") : join(appDir, "inertia");
  const entryPointMetadata = await stat(entryPoint);
  if (!entryPointMetadata.isFile() || (entryPointMetadata.mode & 0o111) === 0) throw new Error(`Desktop Exec entry point is not executable: ${entryPoint}.`);

  const hicolor = join(appDir, "usr", "share", "icons", "hicolor");
  for (const size of EXPECTED_SIZES) {
    const iconPath = join(hicolor, `${size}x${size}`, "apps", "inertia.png");
    const icon = await readFile(iconPath);
    const dimensions = pngDimensions(icon, iconPath);
    if (dimensions.width !== size || dimensions.height !== size) throw new Error(`${iconPath} has unexpected dimensions ${dimensions.width}x${dimensions.height}.`);
  }

  const directoryIconPath = join(appDir, ".DirIcon");
  const directoryIconMetadata = await lstat(directoryIconPath);
  const resolvedDirectoryIcon = directoryIconMetadata.isSymbolicLink() ? await realpath(directoryIconPath) : directoryIconPath;
  const directoryIconRelativePath = relative(appDir, resolvedDirectoryIcon);
  if (!isAbsolute(resolvedDirectoryIcon)
    || directoryIconRelativePath === ".."
    || directoryIconRelativePath.startsWith(`..${sep}`)
    || !await exists(resolvedDirectoryIcon)) throw new Error(".DirIcon does not resolve inside the extracted AppDir.");
  const directoryIcon = await readFile(resolvedDirectoryIcon);
  const directoryDimensions = pngDimensions(directoryIcon, ".DirIcon");
  if (directoryDimensions.width < 256 || directoryDimensions.height < 256) throw new Error(".DirIcon must resolve to a high-resolution Inertia icon.");

  const runtimeIconPath = join(appDir, "resources", "icons", "inertia.png");
  const runtimeIcon = await readFile(runtimeIconPath);
  const sourceRuntimeIcon = await readFile(join(ROOT, "resources", "icons", "512x512.png"));
  if (sha256(runtimeIcon) !== sha256(sourceRuntimeIcon)) throw new Error("The packaged BrowserWindow icon is not the generated Inertia runtime icon.");

  return {
    appDir,
    desktop: Object.fromEntries(desktop),
    directoryIcon: resolvedDirectoryIcon,
    runtimeIcon: runtimeIconPath,
    hicolorSizes: EXPECTED_SIZES,
  };
}

const input = process.argv[2] ? resolve(process.argv[2]) : await findAppImage();
const metadata = await stat(input);
let temporaryDirectory;
try {
  const appDir = metadata.isDirectory()
    ? input
    : await extractAppImage(input, temporaryDirectory = await mkdtemp(join(tmpdir(), "inertia-appimage-")));
  const report = await validateAppDir(appDir);
  console.log(JSON.stringify({ package: input, ...report }, null, 2));
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
