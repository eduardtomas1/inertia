import { isAbsolute } from "node:path";

import {
  runDarwinGuardianHelper,
  type DarwinGuardianHelperResult,
  type DarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";

export type DarwinGuardianIdentity = Pick<
  DarwinProcessIdentity,
  "pid" | "startTimeSeconds" | "startTimeMicroseconds"
>;

export interface DarwinGuardianEscapee {
  readonly pid: number;
  readonly startTimeSeconds: string;
  readonly startTimeMicroseconds: number;
}

export interface DarwinGuardianEscapeeCensus {
  readonly absent: boolean | null;
  readonly remaining: readonly DarwinGuardianEscapee[];
}

export interface DarwinGuardianEscapeeOptions {
  readonly reap: boolean;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly runHelper?: typeof runDarwinGuardianHelper;
}

const UNKNOWN: DarwinGuardianEscapeeCensus = { absent: null, remaining: [] };

function validGuardianIdentity(identity: DarwinGuardianIdentity): boolean {
  return Number.isSafeInteger(identity.pid)
    && identity.pid > 1
    && /^[1-9][0-9]{0,18}$/u.test(identity.startTimeSeconds)
    && Number.isSafeInteger(identity.startTimeMicroseconds)
    && identity.startTimeMicroseconds >= 0
    && identity.startTimeMicroseconds < 1_000_000;
}

function parseEscapee(line: string): DarwinGuardianEscapee | null {
  const match = /^([1-9][0-9]{0,9})\|([1-9][0-9]{0,18})\|([0-9]{1,6})$/u.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const startTimeMicroseconds = Number(match[3]);
  if (pid <= 1 || startTimeMicroseconds >= 1_000_000) return null;
  return { pid, startTimeSeconds: match[2]!, startTimeMicroseconds };
}

export function darwinGuardianEscapeeCensus(
  result: DarwinGuardianHelperResult,
): DarwinGuardianEscapeeCensus {
  if (result.failed || result.signal || result.stderr.trim()) return UNKNOWN;
  if (result.status === 0) return result.stdout.trim() ? UNKNOWN : { absent: true, remaining: [] };
  if (result.status !== 4) return UNKNOWN;
  const remaining = result.stdout.split("\n").filter(Boolean).map(parseEscapee);
  if (remaining.length === 0 || remaining.some((escapee) => escapee === null)) return UNKNOWN;
  return { absent: false, remaining: remaining as DarwinGuardianEscapee[] };
}

export async function readDarwinGuardianEscapeesAsync(
  guardian: DarwinGuardianIdentity,
  guardianPath: string,
  options: DarwinGuardianEscapeeOptions,
): Promise<DarwinGuardianEscapeeCensus> {
  const timeoutMs = Math.trunc(options.timeoutMs);
  if (
    (options.platform ?? process.platform) !== "darwin"
    || !isAbsolute(guardianPath)
    || !validGuardianIdentity(guardian)
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
  ) return UNKNOWN;
  const result = await (options.runHelper ?? runDarwinGuardianHelper)(
    guardianPath,
    [
      "escapees",
      String(guardian.pid),
      guardian.startTimeSeconds,
      String(guardian.startTimeMicroseconds),
      ...(options.reap ? ["--reap"] : []),
    ],
    timeoutMs,
    options.abortSignal,
  );
  return darwinGuardianEscapeeCensus(result);
}
