import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { localFileLocationSuffix, parseLocalFileUrl } from "../shared/local-file-url.js";
import { safeHttpUrl } from "../shared/preview-url.js";
import { openAuthorizedProjectPath } from "./project-path-open.js";

interface DesktopLinkShell {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

/** Called only after validating the requesting primary or detached chat frame. */
export async function openDesktopLink(
  value: unknown,
  shell: DesktopLinkShell,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (typeof value === "string" && /^file:/iu.test(value.trim())) {
    const url = parseLocalFileUrl(value);
    if (!url) throw new Error("Invalid local file link.");
    try {
      let path = fileURLToPath(url, { windows: platform === "win32" });
      const location = localFileLocationSuffix(url.pathname);
      if (location) {
        // Colons cannot be part of an ordinary Windows filename. Treat an
        // unescaped numeric suffix as a source location, not an NTFS stream.
        if (platform === "win32") path = path.slice(0, -location.length);
        else try { await lstat(path); } catch (error) {
          // Prefer an existing literal filename. Only an unescaped source
          // location may fall back, and only when the exact file is absent.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          path = path.slice(0, -location.length);
        }
      }
      const error = await openAuthorizedProjectPath(path, "open-externally", shell, platform);
      if (error) throw new Error("File handler failed.");
    } catch { throw new Error("The local file could not be opened."); }
    return;
  }
  await shell.openExternal(safeHttpUrl(value).toString());
}
