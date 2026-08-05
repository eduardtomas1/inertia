import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { forceKillRuntimeProcessTree } from "../runtime-process-tree";

export type TailscaleFailureClass =
  | "not-installed"
  | "not-running"
  | "logged-out"
  | "permission-denied"
  | "serve-consent-required"
  | "command-timeout"
  | "invalid-status"
  | "unknown";

export class TailscaleCommandError extends Error {
  constructor(
    readonly classification: TailscaleFailureClass,
    message: string,
    readonly stdout = "",
    readonly stderr = "",
  ) {
    super(message);
    this.name = "TailscaleCommandError";
  }
}

export interface TailscaleCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface TailscaleCommandOptions {
  timeoutMs?: number;
  outputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_BYTES = 128 * 1024;

export async function runTailscaleCommand(
  executable: string,
  args: readonly string[],
  options: TailscaleCommandOptions = {},
): Promise<TailscaleCommandResult> {
  if (args.length > 12 || args.some((arg) => arg.length > 2_048 || /[\0\r\n]/u.test(arg))) {
    throw new TailscaleCommandError("unknown", "The Tailscale command was out of bounds.");
  }
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  const outputBytes = Math.max(1_024, Math.min(options.outputBytes ?? DEFAULT_OUTPUT_BYTES, 512 * 1024));
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationStarted = false;
    const child = spawn(executable, [...args], {
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      env: sanitizedEnvironment(options.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error: Error | null, result?: TailscaleCommandResult, afterTermination = false): void => {
      if (settled || (terminationStarted && !afterTermination)) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      if (error) reject(error);
      else resolve(result!);
    };
    const terminate = (error: TailscaleCommandError): void => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      if (!child.pid) { finish(error, undefined, true); return; }
      void forceKillRuntimeProcessTree(child.pid, { rootProcessGroup: true, environment: sanitizedEnvironment(options.env ?? process.env) }).then(
        (confirmed) => finish(confirmed ? error : new TailscaleCommandError("unknown", "Tailscale process cleanup could not be confirmed."), undefined, true),
        () => finish(new TailscaleCommandError("unknown", "Tailscale process cleanup could not be confirmed."), undefined, true),
      );
    };
    const append = (current: string, chunk: Buffer): string | null => {
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next, "utf8") > outputBytes ? null : next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk) ?? "";
      if (stdout === "") terminate(new TailscaleCommandError("unknown", "Tailscale output exceeded its limit."));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk) ?? "";
      if (stderr === "") terminate(new TailscaleCommandError("unknown", "Tailscale output exceeded its limit."));
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(new TailscaleCommandError(
        error.code === "ENOENT" ? "not-installed" : error.code === "EACCES" ? "permission-denied" : "unknown",
        error.code === "ENOENT" ? "Tailscale is not installed." : "Tailscale could not be started.",
      ));
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        finish(new TailscaleCommandError(
          classifyCommandFailure(stderr),
          "Tailscale did not accept the requested operation.",
          stdout,
          stderr,
        ));
        return;
      }
      finish(null, { stdout, stderr, code: code ?? 0 });
    });
    const timer = setTimeout(() => {
      terminate(new TailscaleCommandError("command-timeout", "Tailscale did not respond before the deadline."));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function discoverTailscaleExecutable(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const candidates = new Set<string>();
  const path = platform === "win32" ? win32 : posix;
  const pathEntries = (environment.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry));
  const name = platform === "win32" ? "tailscale.exe" : "tailscale";
  for (const entry of pathEntries) candidates.add(path.join(entry, name));
  if (platform === "win32") {
    for (const root of [environment.ProgramFiles, environment["ProgramFiles(x86)"], environment.LOCALAPPDATA]) {
      if (root && path.isAbsolute(root)) candidates.add(path.join(root, "Tailscale", "tailscale.exe"));
    }
  }
  if (platform === "darwin") {
    candidates.add("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    candidates.add("/Applications/Tailscale.app/Contents/MacOS/tailscale");
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate, platform)) return candidate;
  }
  return null;
}

function sanitizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TMP", "TEMP", "HOME", "USERPROFILE"];
  return {
    ...Object.fromEntries(allowed.flatMap((key) =>
    typeof environment[key] === "string" ? [[key, environment[key]!]] : [],
    )),
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C",
  };
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? undefined : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function classifyCommandFailure(stderr: string): TailscaleFailureClass {
  const detail = stderr.toLocaleLowerCase("en-US");
  if (detail.includes("not running") || detail.includes("daemon")) return "not-running";
  if (detail.includes("login") || detail.includes("logged out")) return "logged-out";
  if (detail.includes("permission") || detail.includes("access denied")) return "permission-denied";
  if (detail.includes("https") && detail.includes("enable")) return "serve-consent-required";
  return "unknown";
}

export function extractTrustedServeConsentUrl(output: string): string | null {
  const matches = output.match(/https:\/\/[^\s"'<>]+/giu) ?? [];
  for (const candidate of matches) {
    try {
      const url = new URL(candidate);
      if (url.hostname === "login.tailscale.com" && url.username === "" && url.password === "" && !url.hash) {
        return url.toString();
      }
    } catch {
      // Ignore malformed command output; it is never surfaced verbatim.
    }
  }
  return null;
}
