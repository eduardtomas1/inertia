import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export interface DarwinProcessIdentity {
  readonly platform: "darwin";
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTimeSeconds: string;
  readonly startTimeMicroseconds: number;
}

const DARWIN_GUARDIAN_HELPER_OUTPUT_BYTES = 4 * 1024;

interface DarwinGuardianHelperResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failed: boolean;
}

function runDarwinGuardianHelper(
  guardianPath: string,
  args: readonly string[],
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<DarwinGuardianHelperResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failed = false;
    const child = spawn(resolve(guardianPath), args, {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", stop);
      resolveResult({ stdout, stderr, status, signal, failed });
    };
    const stop = (): void => {
      failed = true;
      try { child.kill("SIGKILL"); } catch { /* The bounded helper already exited. */ }
    };
    const collect = (target: "stdout" | "stderr", data: Buffer): void => {
      outputBytes += data.byteLength;
      if (outputBytes > DARWIN_GUARDIAN_HELPER_OUTPUT_BYTES) {
        stop();
        return;
      }
      if (target === "stdout") stdout += data.toString("utf8");
      else stderr += data.toString("utf8");
    };
    const timer = setTimeout(stop, timeoutMs);
    timer.unref();
    child.stdout.on("data", (data: Buffer) => collect("stdout", data));
    child.stderr.on("data", (data: Buffer) => collect("stderr", data));
    child.once("error", () => { failed = true; });
    child.once("close", finish);
    abortSignal?.addEventListener("abort", stop, { once: true });
    if (abortSignal?.aborted) stop();
  });
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1;
}

function validParentPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validSeconds(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,30}$/u.test(value);
}

function parseIdentity(pid: number, output: string): DarwinProcessIdentity {
  const match = output.trim().match(
    /^(\d+)\|(\d+)\|(\d+)\|(\d+)\|([1-9][0-9]{0,30})\|(\d{1,6})$/u,
  );
  const parsedPid = Number(match?.[1]);
  const parentPid = Number(match?.[2]);
  const processGroupId = Number(match?.[3]);
  const sessionId = Number(match?.[4]);
  const startTimeSeconds = match?.[5] ?? "";
  const startTimeMicroseconds = Number(match?.[6]);
  if (
    parsedPid !== pid
    || !validParentPid(parentPid)
    || !validPid(processGroupId)
    || processGroupId !== pid
    || !validPid(sessionId)
    || sessionId !== pid
    || !validSeconds(startTimeSeconds)
    || !Number.isSafeInteger(startTimeMicroseconds)
    || startTimeMicroseconds < 0
    || startTimeMicroseconds >= 1_000_000
  ) throw new Error("The macOS owned process identity is invalid.");
  return {
    platform: "darwin",
    pid,
    parentPid,
    processGroupId,
    sessionId,
    startTimeSeconds,
    startTimeMicroseconds,
  };
}

export function readDarwinProcessIdentity(
  pid: number,
  guardianPath: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly deadlineAt?: number;
    readonly spawnProcessSync?: typeof spawnSync;
  } = {},
): DarwinProcessIdentity | null {
  if (
    (options.platform ?? process.platform) !== "darwin"
    || !validPid(pid)
    || !isAbsolute(guardianPath)
  ) return null;
  const remainingMs = Math.trunc(
    (options.deadlineAt ?? Date.now() + 1_000) - Date.now(),
  );
  if (remainingMs <= 0) {
    throw new Error("The macOS owned process identity deadline expired.");
  }
  const result = (options.spawnProcessSync ?? spawnSync)(
    resolve(guardianPath),
    ["identity", String(pid)],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 4_096,
      shell: false,
      timeout: Math.max(1, Math.min(1_000, remainingMs)),
    },
  );
  if (result.error) throw result.error;
  if (result.status === 3 && !result.stdout?.trim()) return null;
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("The macOS owned process identity could not be read.");
  }
  return parseIdentity(pid, result.stdout);
}

export async function readDarwinProcessIdentityAsync(
  pid: number,
  guardianPath: string,
  abortSignal?: AbortSignal,
): Promise<DarwinProcessIdentity | null> {
  if (process.platform !== "darwin" || !validPid(pid) || !isAbsolute(guardianPath)) {
    return null;
  }
  const result = await runDarwinGuardianHelper(
    guardianPath,
    ["identity", String(pid)],
    1_000,
    abortSignal,
  );
  if (result.failed || result.signal || result.stderr.trim()) return null;
  if (result.status === 3 && !result.stdout.trim()) return null;
  if (result.status !== 0) return null;
  try { return parseIdentity(pid, result.stdout); } catch { return null; }
}

export function darwinProcessSessionEmpty(
  sessionId: number,
  guardianPath: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly deadlineAt?: number;
    readonly spawnProcessSync?: typeof spawnSync;
  } = {},
): boolean {
  if (
    (options.platform ?? process.platform) !== "darwin"
    || !validPid(sessionId)
    || !isAbsolute(guardianPath)
  ) throw new Error("The macOS process session identity is invalid.");
  const remainingMs = Math.trunc(
    (options.deadlineAt ?? Date.now() + 1_000) - Date.now(),
  );
  if (remainingMs <= 0) {
    throw new Error("The macOS process session deadline expired.");
  }
  const result = (options.spawnProcessSync ?? spawnSync)(
    resolve(guardianPath),
    ["session-empty", String(sessionId)],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 4_096,
      shell: false,
      timeout: Math.max(1, Math.min(1_000, remainingMs)),
    },
  );
  if (result.error) throw result.error;
  if (result.stdout?.trim() || result.stderr?.trim()) {
    throw new Error("The macOS process session result is invalid.");
  }
  if (result.status === 0) return true;
  if (result.status === 4) return false;
  throw new Error("The macOS process session could not be inspected.");
}

export async function darwinProcessSessionEmptyAsync(
  sessionId: number,
  guardianPath: string,
  abortSignal?: AbortSignal,
): Promise<boolean | null> {
  if (process.platform !== "darwin" || !validPid(sessionId) || !isAbsolute(guardianPath)) {
    return null;
  }
  const result = await runDarwinGuardianHelper(
    guardianPath,
    ["session-empty", String(sessionId)],
    1_000,
    abortSignal,
  );
  if (result.failed || result.signal || result.stderr.trim() || result.stdout.trim()) {
    return null;
  }
  if (result.status === 0) return true;
  if (result.status === 4) return false;
  return null;
}

export function darwinProcessGuardianReady(
  pid: number,
  guardianPath: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly deadlineAt?: number;
    readonly spawnProcessSync?: typeof spawnSync;
  } = {},
): DarwinProcessIdentity | null {
  if (
    (options.platform ?? process.platform) !== "darwin"
    || !validPid(pid)
    || !isAbsolute(guardianPath)
  ) throw new Error("The macOS process guardian identity is invalid.");
  const remainingMs = Math.trunc(
    (options.deadlineAt ?? Date.now() + 1_500) - Date.now(),
  );
  if (remainingMs <= 0) {
    throw new Error("The macOS process guardian readiness deadline expired.");
  }
  const result = (options.spawnProcessSync ?? spawnSync)(
    resolve(guardianPath),
    ["ready", String(pid)],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 4_096,
      shell: false,
      timeout: Math.max(1, Math.min(1_500, remainingMs)),
    },
  );
  if (result.error) throw result.error;
  if (result.stderr?.trim()) {
    throw new Error("The macOS process guardian readiness result is invalid.");
  }
  if (result.status === 0 && typeof result.stdout === "string") {
    return parseIdentity(pid, result.stdout);
  }
  if (result.status === 3 || result.status === 4) {
    if (result.stdout?.trim()) {
      throw new Error("The macOS process guardian readiness result is invalid.");
    }
    return null;
  }
  throw new Error("The macOS process guardian readiness could not be inspected.");
}

export async function darwinProcessGuardianReadyAsync(
  pid: number,
  guardianPath: string,
  abortSignal?: AbortSignal,
): Promise<DarwinProcessIdentity | null> {
  if (process.platform !== "darwin" || !validPid(pid) || !isAbsolute(guardianPath)) {
    return null;
  }
  const result = await runDarwinGuardianHelper(
    guardianPath,
    ["ready", String(pid)],
    1_500,
    abortSignal,
  );
  if (result.failed || result.signal || result.stderr.trim()) return null;
  if ((result.status === 3 || result.status === 4) && !result.stdout.trim()) return null;
  if (result.status !== 0) return null;
  try { return parseIdentity(pid, result.stdout); } catch { return null; }
}
