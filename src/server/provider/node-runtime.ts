import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

import { environmentValue } from "../environment";

export interface NodeRuntimeFileSystem {
  realpath(path: string): string;
  fileSize(path: string): number | null;
  executable?(path: string): boolean;
}

export interface NodeRuntimeSearch {
  platform: NodeJS.Platform;
  fileSystem: NodeRuntimeFileSystem;
  electronExecutable: string | undefined;
  firstDirectory?: string;
}

export const nodeRuntimeFileSystem: NodeRuntimeFileSystem = {
  realpath: (path) => realpathSync.native(path),
  fileSize: (path) => {
    try {
      const details = statSync(path);
      return details.isFile() ? details.size : null;
    } catch {
      return null;
    }
  },
  executable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export function nodeRuntimeOnPath(
  environment: NodeJS.ProcessEnv,
  search: NodeRuntimeSearch,
): string | null {
  const windows = search.platform === "win32";
  const paths = windows ? win32 : posix;
  const executable = windows ? "node.exe" : "node";
  const comparable = (path: string): string => windows ? path.toLowerCase() : path;
  const pathEntries = (environmentValue(environment, "PATH", search.platform) ?? "")
    .split(windows ? ";" : ":")
    .map((entry) => entry.trim())
    .filter((entry) => entry && paths.isAbsolute(entry) && !entry.includes("\0"));
  const electronReal = search.electronExecutable
    ? safeRealpath(search.electronExecutable, search.fileSystem)
    : null;
  const electron = electronReal ? comparable(electronReal) : undefined;
  const directories = search.firstDirectory
    ? [search.firstDirectory, ...pathEntries]
    : pathEntries;
  for (const directory of directories) {
    const candidate = paths.join(directory, executable);
    if (search.fileSystem.fileSize(candidate) === null) continue;
    if (!windows && search.fileSystem.executable?.(candidate) !== true) continue;
    const real = safeRealpath(candidate, search.fileSystem);
    if (!real || comparable(real) === electron) continue;
    if (!windows) return candidate;
    if (comparable(win32.basename(real)) !== executable) continue;
    return real;
  }
  return null;
}

function safeRealpath(
  path: string,
  fileSystem: NodeRuntimeFileSystem,
): string | null {
  try {
    return fileSystem.realpath(path);
  } catch {
    return null;
  }
}
