import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export async function packageSmokePath(fixtureDirectory, {
  environment = process.env, includeGit = false,
} = {}) {
  if (!includeGit) return fixtureDirectory;
  // Match Node's case-insensitive Windows environment selection without
  // restoring unrelated provider installations from the host PATH.
  const pathKey = Object.keys(environment).sort().find((name) => name.toUpperCase() === "PATH");
  const inheritedPath = environment[pathKey] ?? "";
  if (inheritedPath.length > 32_767 || inheritedPath.includes("\0")) {
    throw new Error("Installed history smoke requires a bounded host Git PATH.");
  }
  const directories = inheritedPath.split(delimiter);
  if (directories.length > 256) {
    throw new Error("Installed history smoke has too many host Git PATH entries.");
  }
  const executable = process.platform === "win32" ? "git.exe" : "git";
  for (const entry of directories) {
    const directory = process.platform === "win32" ? entry.replace(/^"(.*)"$/u, "$1") : entry;
    if (!isAbsolute(directory)) continue;
    try {
      const canonicalDirectory = await realpath(directory);
      const candidate = join(canonicalDirectory, executable);
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      // Keep Git in its installation beside its DLLs and libexec resources.
      return [fixtureDirectory, canonicalDirectory].join(delimiter);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code)) throw error;
    }
  }
  throw new Error("Installed history smoke requires Git on the host PATH.");
}
