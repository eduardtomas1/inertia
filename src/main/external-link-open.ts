import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  parseSourceLocationPosition,
  type EditorPosition,
} from "../shared/editors.js";
import { localFileLocationSuffix, parseLocalFileUrl } from "../shared/local-file-url.js";
import { openAuthorizedProjectPath } from "./project-path-open.js";

export interface DesktopLinkShell {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

export type DesktopLinkEditorOpener = (
  path: string,
  position: EditorPosition,
) => Promise<boolean>;

export type DesktopLinkLocalFileAuthorizer = (
  path: string,
) => Promise<string | null>;

export async function openDesktopLink(
  value: unknown,
  shell: DesktopLinkShell,
  platform: NodeJS.Platform = process.platform,
  openInPreferredEditor?: DesktopLinkEditorOpener,
  authorizeLocalFile?: DesktopLinkLocalFileAuthorizer,
): Promise<void> {
  if (typeof value === "string" && /^file:/iu.test(value.trim())) {
    const url = parseLocalFileUrl(value);
    if (!url) throw new Error("Invalid local file link.");
    try {
      let path = fileURLToPath(url, { windows: platform === "win32" });
      const location = localFileLocationSuffix(url.pathname);
      let strippedLocation = "";
      if (location) {
        if (platform === "win32") {
          path = path.slice(0, -location.length);
          strippedLocation = location;
        } else {
          try {
            await lstat(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            path = path.slice(0, -location.length);
            strippedLocation = location;
          }
        }
      }
      if (path.includes("::$") || (platform === "win32" && path.replace(/^[a-z]:/iu, "").includes(":"))) {
        throw new Error("Alternate stream links cannot be opened.");
      }
      if (!authorizeLocalFile) {
        throw new Error("Local file links require authorization.");
      }
      const authorizedPath = await authorizeLocalFile(path);
      if (!authorizedPath) {
        throw new Error("The local file is not authorized.");
      }
      const position = (strippedLocation ? parseSourceLocationPosition(strippedLocation) : null)
        ?? (url.hash ? parseSourceLocationPosition(url.hash) : null)
        ?? {};
      if (openInPreferredEditor && await openInPreferredEditor(authorizedPath, position).catch(() => false)) {
        return;
      }
      const error = await openAuthorizedProjectPath(authorizedPath, "open-link", shell, platform);
      if (error) throw new Error("File handler failed.");
    } catch { throw new Error("The local file could not be opened."); }
    return;
  }
  await shell.openExternal(systemBrowserUrl(value).toString());
}

function systemBrowserUrl(value: unknown): URL {
  if (typeof value !== "string" || !value || value.length > 4_096) throw new Error("Invalid URL");
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Only HTTP and HTTPS links without credentials can be opened");
  }
  return url;
}
