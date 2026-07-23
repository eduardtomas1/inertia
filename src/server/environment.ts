import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

const MAX_ENVIRONMENT_BYTES = 512 * 1024;
const ENVIRONMENT_TIMEOUT_MS = 3_000;
const SAFE_SHELLS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);

export interface ProviderEnvironment {
  env: NodeJS.ProcessEnv;
  pathEntries: string[];
}

let environmentPromise: Promise<ProviderEnvironment> | undefined;

function unique(values: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value) return false;
    const key = platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function environmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return environment[key];
  const normalized = key.toUpperCase();
  const match = Object.keys(environment).find((candidate) => candidate.toUpperCase() === normalized);
  return match ? environment[match] : undefined;
}

function parseEnvironment(buffer: Buffer): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const entry of buffer.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    result[key] = entry.slice(separator + 1);
  }
  return result;
}

async function loginShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return {};
  const configured = process.env.SHELL;
  const shell = configured && isAbsolute(configured) && SAFE_SHELLS.has(basename(configured))
    ? configured
    : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";

  return await new Promise<NodeJS.ProcessEnv>((resolveEnvironment) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: NodeJS.ProcessEnv): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveEnvironment(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-ilc", "/usr/bin/env -0"], {
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish({});
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (size >= MAX_ENVIRONMENT_BYTES) return;
      const remaining = MAX_ENVIRONMENT_BYTES - size;
      const next = chunk.subarray(0, remaining);
      chunks.push(next);
      size += next.length;
    });
    child.once("error", () => finish({}));
    child.once("close", (code) => finish(code === 0 ? parseEnvironment(Buffer.concat(chunks)) : {}));

    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* The shell may already have exited. */ }
      finish({});
    }, ENVIRONMENT_TIMEOUT_MS);
    timer.unref();
  });
}

function commonExecutableDirectories(environment: NodeJS.ProcessEnv): string[] {
  const home = environmentValue(environment, "USERPROFILE") || homedir();
  if (process.platform === "win32") {
    const local = environmentValue(environment, "LOCALAPPDATA");
    const roaming = environmentValue(environment, "APPDATA");
    const pnpm = environmentValue(environment, "PNPM_HOME");
    const bun = environmentValue(environment, "BUN_INSTALL");
    const volta = environmentValue(environment, "VOLTA_HOME");
    const codexInstall = environmentValue(environment, "CODEX_INSTALL_DIR");
    const codexHome = environmentValue(environment, "CODEX_HOME");
    return unique([
      codexInstall ?? "",
      codexInstall ? join(codexInstall, "bin") : "",
      codexHome ?? "",
      codexHome ? join(codexHome, "bin") : "",
      roaming ? join(roaming, "npm") : "",
      pnpm ?? "",
      local ? join(local, "pnpm") : "",
      bun ? join(bun, "bin") : join(home, ".bun", "bin"),
      volta ? join(volta, "bin") : join(home, ".volta", "bin"),
      local ? join(local, "Programs", "OpenAI", "Codex", "bin") : "",
      local ? join(local, "Programs", "cursor", "resources", "app", "bin") : "",
      join(home, "AppData", "Roaming", "npm"),
    ]);
  }

  return unique([
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".npm-global", "bin"),
    join(home, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(process.platform === "darwin" ? [
      "/Applications/ChatGPT.app/Contents/Resources",
      "/Applications/Cursor.app/Contents/Resources/app/bin",
    ] : []),
  ]);
}

async function loadProviderEnvironment(): Promise<ProviderEnvironment> {
  const shellEnvironment = await loginShellEnvironment();
  const env = { ...process.env, ...shellEnvironment };
  const inheritedPath = environmentValue(process.env, "PATH") ?? "";
  const effectivePath = environmentValue(env, "PATH") ?? "";
  const pathEntries = unique([
    ...(effectivePath.split(delimiter)),
    ...(inheritedPath.split(delimiter)),
    ...commonExecutableDirectories(env),
  ]);
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key !== "PATH" && key.toUpperCase() === "PATH") delete env[key];
    }
  }
  env.PATH = pathEntries.join(delimiter);
  return { env, pathEntries };
}

export function providerEnvironment(refresh = false): Promise<ProviderEnvironment> {
  if (refresh || !environmentPromise) environmentPromise = loadProviderEnvironment();
  return environmentPromise;
}

async function executableFile(path: string): Promise<string | null> {
  try {
    if (process.platform !== "win32") await access(path, fsConstants.X_OK);
    const [details, canonical] = await Promise.all([stat(path), realpath(path).catch(() => path)]);
    return details.isFile() ? canonical : null;
  } catch {
    return null;
  }
}

function commandNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [command];
  if (/\.[A-Za-z0-9]+$/u.test(command)) return [command];
  const extensions = (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return unique([command, ...extensions.map((extension) => `${command}${extension}`)]);
}

export async function executableCandidates(
  command: string,
  environment: ProviderEnvironment,
  cwd = process.cwd(),
): Promise<string[]> {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes("\0")) return [];

  const candidates = (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\"))
    ? [isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)]
    : environment.pathEntries.flatMap((directory) => commandNames(trimmed, environment.env).map((name) => join(directory, name)));

  const resolved = await Promise.all(unique(candidates).map(executableFile));
  return unique(resolved.filter((value): value is string => value !== null));
}
