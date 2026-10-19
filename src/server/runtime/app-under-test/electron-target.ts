import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, type PlatformPath } from "node:path";

import { AppUnderTestError } from "./errors";

/**
 * `path.txt` contents written by the `electron` npm package's installer for
 * each platform. Its index.js resolves `dist/<path.txt>`; Inertia repeats
 * that resolution without loading or executing any package code, and
 * deliberately ignores ELECTRON_OVERRIDE_DIST_PATH, which would let the
 * environment pick a binary outside the project.
 */
const ELECTRON_PLATFORM_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Electron.app/Contents/MacOS/Electron",
  freebsd: "electron",
  linux: "electron",
  openbsd: "electron",
  win32: "electron.exe",
};
const MAX_PATH_TXT_BYTES = 256;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAIN_EXTENSIONS = ["", ".js", ".cjs", ".mjs", `${sep}index.js`] as const;

export interface ElectronLaunchTarget {
  /** Realpath of the chat's workspace; the containment root. */
  root: string;
  /** Realpath of the project's own Electron binary, inside `root`. */
  executable: string;
  /** Passed to Electron as the app path, as `electron .` would. */
  appPath: string;
}

/**
 * True when `candidate` is `root` or inside it. Both must be realpaths. With
 * `path.win32` the comparison ignores case, a candidate on another drive or
 * UNC share yields an absolute relative path, and so is never contained.
 */
export function containedPath(
  root: string,
  candidate: string,
  paths: Pick<PlatformPath, "relative" | "isAbsolute" | "sep"> = { relative, isAbsolute, sep },
): boolean {
  const relativePath = paths.relative(root, candidate);
  return relativePath === ""
    || (!paths.isAbsolute(relativePath) && relativePath.split(paths.sep)[0] !== "..");
}

async function contained(root: string, path: string, escape: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new AppUnderTestError("unavailable", escape);
  }
  if (!containedPath(root, real)) {
    throw new AppUnderTestError(
      "invalid",
      "The project's Electron files resolve outside its folder, so Inertia will not start them. Install Electron as a dependency of this project.",
    );
  }
  return real;
}

async function boundedRegularFile(path: string, maximum: number): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maximum) return null;
    const text = await readFile(path, "utf8");
    return Buffer.byteLength(text, "utf8") <= maximum ? text : null;
  } catch {
    return null;
  }
}

async function packageMain(root: string): Promise<string | null> {
  const text = await boundedRegularFile(join(root, "package.json"), MAX_PACKAGE_JSON_BYTES);
  if (text === null) {
    throw new AppUnderTestError(
      "unavailable",
      "This workspace has no readable package.json for Electron to start. Open the chat in the Electron project's folder.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppUnderTestError("invalid", "This workspace's package.json is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppUnderTestError("invalid", "This workspace's package.json is not an object.");
  }
  const main = (parsed as Record<string, unknown>).main;
  if (main === undefined) return null;
  if (typeof main !== "string" || main.length === 0 || main.length > 4_096 || main.includes("\0")) {
    throw new AppUnderTestError("invalid", "The package.json main entry is not a usable path.");
  }
  return main;
}

/** Resolves the project's own Electron binary and app path; never executes anything. */
export async function resolveElectronLaunchTarget(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ElectronLaunchTarget> {
  const binaryName = ELECTRON_PLATFORM_PATHS[platform];
  if (!binaryName) {
    throw new AppUnderTestError("unavailable", "Electron launches are not supported on this platform.");
  }
  let root: string;
  try {
    root = await realpath(workspaceRoot);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AppUnderTestError("unavailable", "This chat's workspace folder is unavailable.");
  }
  const missing = "This project has no node_modules/electron. Install its dependencies, then try again.";
  const packageDirectory = await contained(root, join(root, "node_modules", "electron"), missing);
  const recorded = await boundedRegularFile(join(packageDirectory, "path.txt"), MAX_PATH_TXT_BYTES);
  if (recorded === null || recorded.replace(/\r?\n$/u, "") !== binaryName) {
    throw new AppUnderTestError(
      "unavailable",
      "node_modules/electron has no Electron build for this platform. Reinstall the project's dependencies, then try again.",
    );
  }
  const executable = await contained(root, join(packageDirectory, "dist", binaryName), missing);
  try {
    if (!(await stat(executable)).isFile()) throw new Error("not a file");
    if (platform !== "win32") await access(executable, constants.X_OK);
  } catch {
    throw new AppUnderTestError("unavailable", missing);
  }
  const main = await packageMain(root);
  if (main !== null) {
    let found: string | null = null;
    for (const extension of MAIN_EXTENSIONS) {
      const candidate = resolve(root, `${main}${extension}`);
      try {
        const real = await realpath(candidate);
        if ((await stat(real)).isFile()) {
          found = real;
          break;
        }
      } catch {
        // Try the next resolution Electron would.
      }
    }
    if (found === null) {
      throw new AppUnderTestError(
        "not-found",
        "The package.json main entry does not exist yet. Build the app, then try again.",
      );
    }
    if (!containedPath(root, found)) {
      throw new AppUnderTestError(
        "invalid",
        "The package.json main entry resolves outside this project, so Inertia will not start it.",
      );
    }
  }
  return { root, executable, appPath: root };
}
