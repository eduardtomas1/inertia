import { realpath } from "node:fs";
import { lstat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import type { ProjectPathAction } from "../shared/desktop";

const LAUNCHABLE_EXTENSIONS = new Set([
  ".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".psd1", ".ps1xml", ".psc1", ".lnk",
  ".msi", ".msp", ".mst", ".msu", ".msix", ".msixbundle", ".appx", ".appxbundle", ".appinstaller",
  ".scr", ".cpl", ".msc", ".inf", ".diagcab", ".gadget",
  ".vb", ".vbs", ".vbe", ".js", ".jse", ".ws", ".wsf", ".wsh", ".wsc", ".sct", ".hta", ".reg",
  ".url", ".website", ".application", ".appref-ms", ".xbap", ".scf", ".jnlp",
  ".library-ms", ".searchconnector-ms", ".search-ms", ".settingcontent-ms", ".rdp",
  ".theme", ".themepack", ".deskthemepack", ".ahk", ".iqy", ".slk",
  ".app", ".command", ".tool", ".terminal", ".pkg", ".workflow", ".webloc",
  ".desktop", ".appimage", ".sh", ".bash", ".zsh", ".fish",
  ".py", ".pyw", ".pyz", ".pyzw", ".pyc", ".pyo", ".pl", ".rb", ".rbw",
  ".jar", ".inetloc", ".fileloc", ".afploc", ".chm", ".dmg", ".iso", ".img",
  ".vhd", ".vhdx", ".pif",
  ".doc", ".dot", ".docm", ".dotm", ".xls", ".xlt", ".xla", ".xlsb", ".xlsm", ".xltm", ".xlam", ".xll",
  ".ppt", ".pps", ".pot", ".ppa", ".pptm", ".potm", ".ppsm", ".ppam", ".sldm",
  ".mdb", ".mde", ".accdb", ".accde",
]);

const nativeRealpath = promisify(realpath.native);
const portableRealpath = promisify(realpath);

const INERT_LINK_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".log",
  ".json", ".jsonc", ".yaml", ".yml", ".toml",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".pdf",
  ".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus",
  ".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi",
]);

export type ProjectPathOpenAction = ProjectPathAction | "open-link";

interface ProjectPathShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

function windowsSegments(path: string): { device: boolean; rest: string; segments: string[] } {
  const slash = path.replace(/\//gu, "\\");
  const rest = slash.replace(/^[a-z]:/iu, "");
  return { device: /^\\\\[?.]\\/u.test(slash), rest, segments: rest.split("\\") };
}

export function hasWindowsStreamOrDeviceSpelling(path: string): boolean {
  const { device, rest, segments } = windowsSegments(path);
  return device || rest.includes(":") || segments.some((segment) => /[. ]$/u.test(segment));
}

export function hasWindowsShortNameComponent(path: string): boolean {
  return windowsSegments(path).segments.some((segment) => /~\d/u.test(segment));
}

function extensionOf(path: string, platform: NodeJS.Platform): string {
  const name = platform === "win32" ? path.replace(/[ .]+$/u, "") : path;
  return extname(name).toLowerCase();
}

async function resolveTarget(path: string): Promise<string | null> {
  try {
    return await nativeRealpath(path);
  } catch {
    return await portableRealpath(path).catch(() => null);
  }
}

function permitsOpen(
  path: string,
  resolved: string,
  action: Exclude<ProjectPathOpenAction, "reveal">,
  isFile: boolean,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32" && [path, resolved].some((candidate) => hasWindowsStreamOrDeviceSpelling(candidate)
    || hasWindowsShortNameComponent(candidate))) return false;
  const extensions = [extensionOf(path, platform), extensionOf(resolved, platform)];
  if (action === "open-link") return isFile && extensions.every((extension) => INERT_LINK_EXTENSIONS.has(extension));
  return !extensions.some((extension) => LAUNCHABLE_EXTENSIONS.has(extension));
}

/** The calling desktop operation must authorize the path before this call. */
export async function openAuthorizedProjectPath(
  path: string,
  action: ProjectPathOpenAction,
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
  const resolved = metadata.isSymbolicLink() ? path : await resolveTarget(path);
  const launchable = resolved === null
    || metadata.isSymbolicLink()
    || (platform !== "win32" && metadata.isFile() && (metadata.mode & 0o111) !== 0)
    || !permitsOpen(path, resolved, action, metadata.isFile(), platform);
  if (launchable) {
    shell.showItemInFolder(path);
    return "";
  }
  return shell.openPath(path);
}
