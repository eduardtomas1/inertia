import type { DarwinProcessIdentity } from "./runtime-owned-process-darwin.js";
import { validRuntimeGenerationId, validSystemBootId } from "./runtime-identity-protocol.js";
import {
  RUNTIME_OWNED_PROCESS_SESSION_VERSION as SCHEMA_VERSION,
  type RuntimeOwnedProcessSession,
} from "./runtime-owned-process-session-journal.js";

export const RUNTIME_OWNERSHIP_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_PATTERN = RUNTIME_OWNERSHIP_UUID_PATTERN;

export interface LinuxProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startTimeTicks: string;
  readonly guardianExecutableDevice?: string;
  readonly guardianExecutableInode?: string;
}

export type RuntimeOwnedProcessPlatform = "linux" | "darwin" | "win32";

export interface WindowsProcessIdentity {
  readonly platform: "win32";
  readonly pid: number;
  readonly processGroupId: null;
  readonly startedAfterMs: number;
  readonly startedBeforeMs: number;
}

export interface ObservedWindowsProcessIdentity {
  readonly platform: "win32";
  readonly pid: number;
  readonly processGroupId: null;
  readonly startedAtMs: number;
}

export type RuntimeOwnedProcessIdentity =
  | LinuxProcessIdentity
  | DarwinProcessIdentity
  | WindowsProcessIdentity;

export type ObservedRuntimeOwnedProcessIdentity =
  | LinuxProcessIdentity
  | DarwinProcessIdentity
  | ObservedWindowsProcessIdentity;

export interface WindowsRuntimeJobContainment {
  readonly kind: "windows-job-v1";
  readonly name: string;
}

export type RuntimeOwnedProcessContainment = WindowsRuntimeJobContainment;

export interface StoredRuntimeOwnedProcessContainment extends RuntimeOwnedProcessSession {
  readonly containment: RuntimeOwnedProcessContainment;
}

export interface RuntimeOwnedProcessPendingBase extends RuntimeOwnedProcessSession {
  readonly state: "pending";
  readonly ownershipId: string;
}
export interface RuntimeOwnedDarwinProcessPending extends RuntimeOwnedProcessPendingBase {
  readonly containment: "darwin-parent-watchdog-v1";
  readonly runtimeParentPid: number;
}
export interface RuntimeOwnedLinuxProcessPending extends RuntimeOwnedProcessPendingBase {
  readonly containment: "linux-parent-gated-v1";
  readonly runtimeParentPid: number;
  readonly runtimeParentStartTimeTicks: string;
}
export interface RuntimeOwnedLegacyProcessPending extends RuntimeOwnedProcessPendingBase {
  readonly containment?: never;
  readonly runtimeParentPid?: never;
}
export type RuntimeOwnedProcessPending = RuntimeOwnedDarwinProcessPending
  | RuntimeOwnedLinuxProcessPending
  | RuntimeOwnedLegacyProcessPending;

export interface RuntimeOwnedProcessClaim extends RuntimeOwnedProcessSession {
  readonly state: "preauth" | "owned" | "retiring";
  readonly ownershipId: string;
  readonly process: RuntimeOwnedProcessIdentity;
}

export type RuntimeOwnedProcessRecord =
  RuntimeOwnedProcessPending | RuntimeOwnedProcessClaim;

export function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1;
}

export function validParentPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

export function validTicks(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,30}$/u.test(value);
}

function validMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseRuntimeOwnedProcessRecord(
  bytes: Buffer,
  legacyWindowsUnobserved = false,
): RuntimeOwnedProcessRecord | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<RuntimeOwnedProcessRecord>;
    if (
      record.version !== SCHEMA_VERSION
      || !validRuntimeGenerationId(record.runtimeGenerationId)
      || !validSystemBootId(record.systemBootId)
      || typeof record.ownershipId !== "string"
      || !UUID_PATTERN.test(record.ownershipId)
    ) return null;
    if (record.state === "pending") {
      const legacy = exactKeys(value, [
        "ownershipId", "runtimeGenerationId", "state", "systemBootId", "version",
      ]);
      const guardedDarwin = exactKeys(value, [
        "containment", "ownershipId", "runtimeGenerationId", "runtimeParentPid",
        "state", "systemBootId", "version",
      ])
        && record.containment === "darwin-parent-watchdog-v1"
        && validPid(record.runtimeParentPid);
      const guardedLinux = exactKeys(value, [
        "containment", "ownershipId", "runtimeGenerationId", "runtimeParentPid",
        "runtimeParentStartTimeTicks", "state", "systemBootId", "version",
      ])
        && record.containment === "linux-parent-gated-v1"
        && validPid(record.runtimeParentPid)
        && validTicks((record as Partial<RuntimeOwnedLinuxProcessPending>).runtimeParentStartTimeTicks);
      return legacy || guardedDarwin || guardedLinux
        ? record as RuntimeOwnedProcessPending
        : null;
    }
    if (
      (record.state !== "preauth" && record.state !== "owned" && record.state !== "retiring")
      || !exactKeys(value, [
        "ownershipId",
        "process",
        "runtimeGenerationId",
        "state",
        "systemBootId",
        "version",
      ])
      || !record.process
      || typeof record.process !== "object"
    ) return null;
    const identity = record.process as Partial<RuntimeOwnedProcessIdentity>;
    const linuxIdentity = (exactKeys(record.process, [
      "parentPid", "pid", "processGroupId", "startTimeTicks",
    ]) || exactKeys(record.process, [
      "guardianExecutableDevice", "guardianExecutableInode",
      "parentPid", "pid", "processGroupId", "startTimeTicks",
    ]))
      && validPid(identity.pid)
      && validPid((identity as Partial<LinuxProcessIdentity>).parentPid)
      && validPid(identity.processGroupId)
      && validTicks((identity as Partial<LinuxProcessIdentity>).startTimeTicks)
      && (
        !("guardianExecutableDevice" in record.process)
        || (
          validTicks((identity as Partial<LinuxProcessIdentity>).guardianExecutableDevice)
          && validTicks((identity as Partial<LinuxProcessIdentity>).guardianExecutableInode)
        )
      );
    const darwinIdentity = exactKeys(record.process, [
      "parentPid",
      "pid",
      "platform",
      "processGroupId",
      "sessionId",
      "startTimeMicroseconds",
      "startTimeSeconds",
    ])
      && (identity as Partial<DarwinProcessIdentity>).platform === "darwin"
      && validPid(identity.pid)
      && validParentPid((identity as Partial<DarwinProcessIdentity>).parentPid)
      && validPid(identity.processGroupId)
      && identity.processGroupId === identity.pid
      && validPid((identity as Partial<DarwinProcessIdentity>).sessionId)
      && (identity as Partial<DarwinProcessIdentity>).sessionId === identity.pid
      && validTicks((identity as Partial<DarwinProcessIdentity>).startTimeSeconds)
      && Number.isSafeInteger(
        (identity as Partial<DarwinProcessIdentity>).startTimeMicroseconds,
      )
      && Number((identity as Partial<DarwinProcessIdentity>).startTimeMicroseconds) >= 0
      && Number((identity as Partial<DarwinProcessIdentity>).startTimeMicroseconds) < 1_000_000;
    const windowsIdentity = exactKeys(record.process, [
      "pid",
      "platform",
      "processGroupId",
      "startedAfterMs",
      "startedBeforeMs",
    ])
      && (identity as Partial<WindowsProcessIdentity>).platform === "win32"
      && (validPid(identity.pid)
        || (legacyWindowsUnobserved && record.state === "owned" && identity.pid === 0))
      && identity.processGroupId === null
      && validMilliseconds((identity as Partial<WindowsProcessIdentity>).startedAfterMs)
      && validMilliseconds((identity as Partial<WindowsProcessIdentity>).startedBeforeMs)
      && Number((identity as Partial<WindowsProcessIdentity>).startedAfterMs)
        <= Number((identity as Partial<WindowsProcessIdentity>).startedBeforeMs);
    if (!linuxIdentity && !darwinIdentity && !windowsIdentity) return null;
    if (record.state === "preauth" && (!linuxIdentity
      || !("guardianExecutableDevice" in record.process))) return null;
    return record as RuntimeOwnedProcessClaim;
  } catch {
    return null;
  }
}

export function parseRuntimeOwnedProcessRecordLeaf(
  bytes: Buffer,
  expectedOwnershipId: string,
): RuntimeOwnedProcessRecord | null {
  const record = parseRuntimeOwnedProcessRecord(bytes);
  return record
    && UUID_PATTERN.test(expectedOwnershipId)
    && record.ownershipId.toLowerCase() === expectedOwnershipId.toLowerCase()
    ? record
    : null;
}

/** Recognizes only the historical writer bug; ordinary readers remain strict. */
export function parseLegacyWindowsUnobservedProcessRecordLeaf(
  bytes: Buffer,
  expectedOwnershipId: string,
): RuntimeOwnedProcessClaim | null {
  const record = parseRuntimeOwnedProcessRecord(bytes, true);
  return record?.state === "owned"
    && "platform" in record.process
    && record.process.platform === "win32"
    && record.process.pid === 0
    && UUID_PATTERN.test(expectedOwnershipId)
    && record.ownershipId === expectedOwnershipId
    ? record
    : null;
}
