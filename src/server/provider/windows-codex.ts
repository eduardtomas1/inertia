import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { win32 } from "node:path";

import {
  environmentValue,
  executableCandidates,
  type ProviderEnvironment,
} from "../environment";
import { CappedProviderBuffer } from "./io";

const WHERE_TIMEOUT_MS = 2_500;
const MAX_WHERE_OUTPUT_BYTES = 64 * 1024;

function uniqueWindowsPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const key = win32.normalize(trimmed).toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function executablePaths(directory: string): string[] {
  if (!directory) return [];
  return ["codex.exe", "codex.cmd", "codex.bat", "codex.com"].map((name) => win32.join(directory, name));
}

function customInstallPaths(path: string | undefined): string[] {
  const value = path?.trim();
  if (!value || value.includes("\0")) return [];
  if (/\.(?:exe|cmd|bat|com)$/iu.test(value)) return [value];
  return [
    ...executablePaths(value),
    ...executablePaths(win32.join(value, "bin")),
    ...executablePaths(win32.join(value, "packages", "standalone", "current")),
    ...executablePaths(win32.join(value, "packages", "standalone", "current", "bin")),
  ];
}

/** Candidate paths independent of PATH/where.exe, ordered by install intent. */
export function windowsCodexKnownPaths(environment: NodeJS.ProcessEnv): string[] {
  const home = environmentValue(environment, "USERPROFILE", "win32") || homedir();
  const local = environmentValue(environment, "LOCALAPPDATA", "win32") || win32.join(home, "AppData", "Local");
  const roaming = environmentValue(environment, "APPDATA", "win32") || win32.join(home, "AppData", "Roaming");
  const codexHome = environmentValue(environment, "CODEX_HOME", "win32");
  const codexInstall = environmentValue(environment, "CODEX_INSTALL_DIR", "win32");
  const pnpmHome = environmentValue(environment, "PNPM_HOME", "win32");
  const bunInstall = environmentValue(environment, "BUN_INSTALL", "win32");
  const voltaHome = environmentValue(environment, "VOLTA_HOME", "win32");

  return uniqueWindowsPaths([
    ...customInstallPaths(codexInstall),
    ...customInstallPaths(codexHome),
    win32.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    win32.join(home, ".codex", "packages", "standalone", "current", "bin", "codex.exe"),
    win32.join(home, ".codex", "packages", "standalone", "current", "codex.exe"),
    ...executablePaths(win32.join(roaming, "npm")),
    ...executablePaths(pnpmHome || win32.join(local, "pnpm")),
    ...executablePaths(win32.join(roaming, "pnpm")),
    ...executablePaths(win32.join(home, "AppData", "Local", "pnpm")),
    ...executablePaths(win32.join(bunInstall || win32.join(home, ".bun"), "bin")),
    ...executablePaths(win32.join(voltaHome || win32.join(home, ".volta"), "bin")),
  ]);
}

export function parseWhereExecutableOutput(output: string): string[] {
  return uniqueWindowsPaths(output
    .split(/\r?\n/u)
    .slice(0, 128)
    .map((line) => line.trim().replace(/^"(.*)"$/u, "$1"))
    .filter((line) => win32.isAbsolute(line) && !line.includes("\0")));
}

async function whereCodex(environment: ProviderEnvironment, cwd: string): Promise<string[]> {
  const systemRoot = environmentValue(environment.env, "SystemRoot", "win32");
  const whereExecutable = systemRoot ? win32.join(systemRoot, "System32", "where.exe") : "where.exe";
  return await new Promise<string[]>((resolve) => {
    const output = new CappedProviderBuffer(MAX_WHERE_OUTPUT_BYTES);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (paths: string[]): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(paths);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(whereExecutable, ["codex"], {
        cwd,
        env: environment.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish([]);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    child.once("error", () => finish([]));
    child.once("close", (code) => finish(code === 0 ? parseWhereExecutableOutput(output.toString()) : []));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* The utility may already have exited. */ }
      finish([]);
    }, WHERE_TIMEOUT_MS);
    timer.unref();
  });
}

export async function windowsCodexExecutableCandidates(
  environment: ProviderEnvironment,
  cwd: string,
): Promise<string[]> {
  const [pathCandidates, whereCandidates] = await Promise.all([
    executableCandidates("codex", environment, cwd),
    whereCodex(environment, cwd),
  ]);
  const candidates = uniqueWindowsPaths([
    ...windowsCodexKnownPaths(environment.env),
    ...pathCandidates,
    ...whereCandidates,
  ]);
  const validated = await Promise.all(candidates.map(async (candidate) =>
    await executableCandidates(candidate, environment, cwd)));
  return uniqueWindowsPaths(validated.flat());
}
