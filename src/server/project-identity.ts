import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IDENTITY_TIMEOUT_MS = 3_000;
const MAX_IDENTITY_OUTPUT = 16 * 1024;

export interface ProjectIdentity {
  normalizedPath: string;
  repositoryIdentity: string | null;
  repositoryRoot: string | null;
  repositoryRelativePath: string;
}

export function normalizeIdentityPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const slashPath = path.replace(/\\/gu, "/").replace(/\/+/gu, "/");
  if (platform !== "win32") return slashPath.length > 1 ? slashPath.replace(/\/$/u, "") : slashPath;
  const normalized = win32.normalize(path).replace(/\\/gu, "/").replace(/\/+/gu, "/");
  return normalized.replace(/^([A-Z]):/u, (_match, drive: string) => `${drive.toLowerCase()}:`).toLocaleLowerCase("en-US").replace(/\/$/u, "");
}

async function canonicalDirectory(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function gitValue(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: IDENTITY_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: MAX_IDENTITY_OUTPUT,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      LC_ALL: "C",
    },
  });
  return result.stdout.trim();
}

export async function inspectProjectIdentity(projectPath: string): Promise<ProjectIdentity> {
  const canonicalPath = await canonicalDirectory(projectPath);
  const normalizedPath = normalizeIdentityPath(canonicalPath);
  try {
    const repositoryRootValue = await gitValue(canonicalPath, ["rev-parse", "--show-toplevel"]);
    if (!isAbsolute(repositoryRootValue)) throw new Error("Git returned a relative repository root.");
    const repositoryRoot = await canonicalDirectory(repositoryRootValue);
    let commonDirectoryValue: string;
    try {
      commonDirectoryValue = await gitValue(canonicalPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    } catch {
      const relativeCommonDirectory = await gitValue(canonicalPath, ["rev-parse", "--git-common-dir"]);
      commonDirectoryValue = isAbsolute(relativeCommonDirectory)
        ? relativeCommonDirectory
        : resolve(canonicalPath, relativeCommonDirectory);
    }
    const commonDirectory = await canonicalDirectory(commonDirectoryValue);
    const repositoryRelativePath = normalizeIdentityPath(relative(repositoryRoot, canonicalPath) || ".");
    return {
      normalizedPath,
      repositoryIdentity: `git:${normalizeIdentityPath(commonDirectory)}`,
      repositoryRoot: normalizeIdentityPath(repositoryRoot),
      repositoryRelativePath,
    };
  } catch {
    return {
      normalizedPath,
      repositoryIdentity: null,
      repositoryRoot: null,
      repositoryRelativePath: ".",
    };
  }
}
