import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export interface DarwinProcessIdentity {
  readonly platform: "darwin";
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startTimeSeconds: string;
  readonly startTimeMicroseconds: number;
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
  const match = result.stdout.trim().match(
    /^(\d+)\|(\d+)\|(\d+)\|([1-9][0-9]{0,30})\|(\d{1,6})$/u,
  );
  const parsedPid = Number(match?.[1]);
  const parentPid = Number(match?.[2]);
  const processGroupId = Number(match?.[3]);
  const startTimeSeconds = match?.[4] ?? "";
  const startTimeMicroseconds = Number(match?.[5]);
  if (
    parsedPid !== pid
    || !validParentPid(parentPid)
    || !validPid(processGroupId)
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
    startTimeSeconds,
    startTimeMicroseconds,
  };
}
