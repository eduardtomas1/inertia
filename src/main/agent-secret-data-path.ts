import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";

function stripWin32ExtendedPrefix(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function canonicalizeWin32Path(
  target: string,
  resolveRealpath: (path: string) => string,
): { canonical: string; failed: boolean } {
  const resolved = win32.resolve(target);
  let current = resolved;
  const missing: string[] = [];
  while (true) {
    try {
      const canonical = win32.resolve(stripWin32ExtendedPrefix(resolveRealpath(current)));
      return {
        canonical: missing.length === 0 ? canonical : win32.join(canonical, ...missing.reverse()),
        failed: false,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return { canonical: resolved, failed: true };
      }
      const parent = win32.dirname(current);
      if (parent === current) {
        return { canonical: resolved, failed: false };
      }
      missing.push(win32.basename(current));
      current = parent;
    }
  }
}

export function agentSecretDataPath(input: {
  platform: NodeJS.Platform;
  dataDirectory: string;
  userDataPath: string;
  realpath?: (path: string) => string;
}): string {
  if (input.platform !== "win32") return input.dataDirectory;
  const resolveRealpath = input.realpath ?? realpathSync.native;
  const canonicalData = canonicalizeWin32Path(input.dataDirectory, resolveRealpath);
  const canonicalUser = canonicalizeWin32Path(input.userDataPath, resolveRealpath);
  const dataDirectory = canonicalData.canonical.toLowerCase();
  const userData = canonicalUser.canonical.toLowerCase();
  const userDataPrefix = userData.endsWith("\\") ? userData : `${userData}\\`;
  if (
    !canonicalData.failed
    && !canonicalUser.failed
    && (dataDirectory === userData || dataDirectory.startsWith(userDataPrefix))
  ) {
    return input.dataDirectory;
  }
  const key = createHash("sha256").update(dataDirectory).digest("hex").slice(0, 16);
  return win32.join(input.userDataPath, "private", key);
}
