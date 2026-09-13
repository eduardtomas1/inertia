import { lstat } from "node:fs/promises";
import { extname } from "node:path";
import type { OpenProjectPathRequest } from "../shared/desktop";

const LAUNCHABLE_EXTENSIONS = new Set([
  ".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".psd1", ".lnk",
  ".msi", ".msp", ".mst", ".msix", ".appx", ".scr", ".cpl", ".msc",
  ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".reg",
  ".url", ".website", ".application", ".appref-ms", ".scf",
  ".app", ".command", ".tool", ".terminal", ".pkg", ".workflow", ".webloc",
  ".desktop", ".appimage", ".sh", ".bash", ".zsh", ".fish", ".py", ".pl",
]);

interface ProjectPathShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

/** The runtime must resolve and authorize the project path before this call. */
export async function openAuthorizedProjectPath(
  path: string,
  action: OpenProjectPathRequest["action"],
  shell: ProjectPathShell,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (action === "reveal") {
    shell.showItemInFolder(path);
    return "";
  }
  let metadata;
  try { metadata = await lstat(path); } catch {
    throw new Error("The project file could not be inspected.");
  }
  const name = platform === "win32" ? path.replace(/[ .]+$/u, "") : path;
  const launchable = LAUNCHABLE_EXTENSIONS.has(extname(name).toLowerCase())
    || metadata.isSymbolicLink()
    || (platform !== "win32" && metadata.isFile() && (metadata.mode & 0o111) !== 0);
  if (launchable) {
    shell.showItemInFolder(path);
    return "";
  }
  return shell.openPath(path);
}
