import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  discardDirectRuntimeJournalLeaf,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  renameDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
} from "./direct-runtime-journal.js";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "./runtime-process-protocol.js";
import {
  darwinProcessGuardianReady,
  darwinProcessSessionEmpty,
  readDarwinProcessIdentity,
  type DarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";
import {
  exactProcessGroupAbsent,
  failedClaimProcessCanExecute,
} from "./runtime-owned-process-posix.js";
export {
  darwinProcessGuardianReady,
  darwinProcessSessionEmpty,
  readDarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";
export type { DarwinProcessIdentity } from "./runtime-owned-process-darwin.js";
const CLAIM_PREFIX = ".runtime-owned-child-";
const SESSION_PREFIX = ".runtime-owned-process-session-";
const CONTAINMENT_PREFIX = ".runtime-owned-process-containment-";
const MAX_CLAIMS = 256;
const MAX_SESSIONS = 32;
const MAX_RECORD_BYTES = 768;
const SCHEMA_VERSION = 1;
const PROCESS_GROUP_EXIT_WAIT_MS = 1_000;
const PROCESS_GROUP_EXIT_POLL_MS = 10;
const PID_PROCESS_GROUP_SETTLE_WAIT_MS = 100;
const PID_PROCESS_GROUP_SETTLE_POLL_MS = 1;
const PID_PROCESS_GROUP_SETTLE_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LinuxProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startTimeTicks: string;
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

interface RuntimeOwnedProcessSession {
  readonly version: typeof SCHEMA_VERSION;
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
}

export interface WindowsRuntimeJobContainment {
  readonly kind: "windows-job-v1";
  readonly name: string;
}

export type RuntimeOwnedProcessContainment = WindowsRuntimeJobContainment;

interface StoredRuntimeOwnedProcessContainment extends RuntimeOwnedProcessSession {
  readonly containment: RuntimeOwnedProcessContainment;
}

interface RuntimeOwnedProcessPendingBase extends RuntimeOwnedProcessSession {
  readonly state: "pending";
  readonly ownershipId: string;
}
export interface RuntimeOwnedDarwinProcessPending extends RuntimeOwnedProcessPendingBase {
  readonly containment: "darwin-parent-watchdog-v1";
  readonly runtimeParentPid: number;
}
interface RuntimeOwnedLegacyProcessPending extends RuntimeOwnedProcessPendingBase {
  readonly containment?: never;
  readonly runtimeParentPid?: never;
}
type RuntimeOwnedProcessPending = RuntimeOwnedDarwinProcessPending
  | RuntimeOwnedLegacyProcessPending;

export interface RuntimeOwnedProcessClaim extends RuntimeOwnedProcessSession {
  readonly state: "owned";
  readonly ownershipId: string;
  readonly process: RuntimeOwnedProcessIdentity;
}

type RuntimeOwnedProcessRecord = RuntimeOwnedProcessPending | RuntimeOwnedProcessClaim;

function generationHash(runtimeGenerationId: string): string {
  return createHash("sha256").update(runtimeGenerationId).digest("hex");
}

function sessionName(runtimeGenerationId: string): string {
  return `${SESSION_PREFIX}${generationHash(runtimeGenerationId)}.json`;
}

function containmentName(runtimeGenerationId: string): string {
  return `${CONTAINMENT_PREFIX}${generationHash(runtimeGenerationId)}.json`;
}

function claimName(ownershipId: string): string {
  return `${CLAIM_PREFIX}${ownershipId}.json`;
}

function temporaryClaimName(
  ownershipId: string,
  operation: "begin" | "claim" | "consume",
): string {
  return `${CLAIM_PREFIX}${ownershipId}.${operation}.tmp`;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1;
}

function validParentPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validTicks(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,30}$/u.test(value);
}

function validMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function supportedRuntimeOwnedProcessPlatform(
  platform: NodeJS.Platform,
): platform is RuntimeOwnedProcessPlatform {
  return platform === "linux" || platform === "darwin" || platform === "win32";
}

function parseSession(bytes: Buffer): RuntimeOwnedProcessSession | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || !exactKeys(value, [
      "runtimeGenerationId",
      "systemBootId",
      "version",
    ])) return null;
    const session = value as Partial<RuntimeOwnedProcessSession>;
    return session.version === SCHEMA_VERSION
      && validRuntimeGenerationId(session.runtimeGenerationId)
      && validSystemBootId(session.systemBootId)
      ? session as RuntimeOwnedProcessSession
      : null;
  } catch {
    return null;
  }
}

function parseContainment(
  bytes: Buffer,
  expectedRuntimeGenerationId: string,
  expectedSystemBootId: string,
): RuntimeOwnedProcessContainment | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || !exactKeys(value, [
      "containment",
      "runtimeGenerationId",
      "systemBootId",
      "version",
    ])) return null;
    const stored = value as Partial<StoredRuntimeOwnedProcessContainment>;
    if (
      stored.version !== SCHEMA_VERSION
      || stored.runtimeGenerationId !== expectedRuntimeGenerationId
      || stored.systemBootId !== expectedSystemBootId
      || !stored.containment
      || typeof stored.containment !== "object"
      || !exactKeys(stored.containment, ["kind", "name"])
      || stored.containment.kind !== "windows-job-v1"
      || typeof stored.containment.name !== "string"
      || !/^Global\\InertiaRuntime-[0-9a-f]{64}$/u.test(stored.containment.name)
    ) return null;
    return stored.containment;
  } catch {
    return null;
  }
}

function parseRecord(bytes: Buffer): RuntimeOwnedProcessRecord | null {
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
      return legacy || guardedDarwin
        ? record as RuntimeOwnedProcessPending
        : null;
    }
    if (
      record.state !== "owned"
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
    const linuxIdentity = exactKeys(record.process, [
      "parentPid",
      "pid",
      "processGroupId",
      "startTimeTicks",
    ])
      && validPid(identity.pid)
      && validPid((identity as Partial<LinuxProcessIdentity>).parentPid)
      && validPid(identity.processGroupId)
      && validTicks((identity as Partial<LinuxProcessIdentity>).startTimeTicks);
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
      && validPid(identity.pid)
      && identity.processGroupId === null
      && validMilliseconds((identity as Partial<WindowsProcessIdentity>).startedAfterMs)
      && validMilliseconds((identity as Partial<WindowsProcessIdentity>).startedBeforeMs)
      && Number((identity as Partial<WindowsProcessIdentity>).startedAfterMs)
        <= Number((identity as Partial<WindowsProcessIdentity>).startedBeforeMs);
    if (!linuxIdentity && !darwinIdentity && !windowsIdentity) return null;
    return record as RuntimeOwnedProcessClaim;
  } catch {
    return null;
  }
}

export function readLinuxProcessIdentity(
  pid: number,
  readFile: (path: string, encoding: "utf8") => string = (path, encoding) =>
    readFileSync(path, encoding),
): LinuxProcessIdentity | null {
  if (process.platform !== "linux" || !validPid(pid)) return null;
  let stat: string;
  try {
    stat = readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ESRCH")
    ) return null;
    throw error;
  }
  if (stat.length < 1 || stat.length > 16_384) {
    throw new Error("The owned process identity is invalid.");
  }
  const closingName = stat.lastIndexOf(")");
  if (closingName < 2) throw new Error("The owned process identity is invalid.");
  const parsedPid = Number(stat.slice(0, stat.indexOf(" ")));
  const fields = stat.slice(closingName + 2).trim().split(/\s+/u);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (
    parsedPid !== pid
    || !validParentPid(parentPid)
    || !validPid(processGroupId)
    || !validTicks(startTimeTicks)
  ) throw new Error("The owned process identity is invalid.");
  return { pid, parentPid, processGroupId, startTimeTicks };
}

function sameProcess(
  left: RuntimeOwnedProcessIdentity,
  right: ObservedRuntimeOwnedProcessIdentity,
): boolean {
  if ("startTimeTicks" in left) {
    return "startTimeTicks" in right
      && left.pid === right.pid
      && left.processGroupId === right.processGroupId
      && left.startTimeTicks === right.startTimeTicks;
  }
  if (left.platform === "darwin") {
    return "startTimeSeconds" in right
      && right.platform === "darwin"
      && left.pid === right.pid
      && left.processGroupId === right.processGroupId
      && left.sessionId === right.sessionId
      && left.startTimeSeconds === right.startTimeSeconds
      && left.startTimeMicroseconds === right.startTimeMicroseconds;
  }
  return "startedAtMs" in right
    && left.platform === right.platform
    && left.pid === right.pid
    && left.processGroupId === right.processGroupId
    && right.startedAtMs >= left.startedAfterMs
    && right.startedAtMs <= left.startedBeforeMs;
}

function stored(
  value: RuntimeOwnedProcessSession
    | RuntimeOwnedProcessRecord
    | StoredRuntimeOwnedProcessContainment,
): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function readSessions(
  root: DirectRuntimeJournalRoot,
): RuntimeOwnedProcessSession[] {
  const names = listDirectRuntimeJournalLeaves(
    root,
    SESSION_PREFIX,
    MAX_SESSIONS * 2,
  );
  const sessions: RuntimeOwnedProcessSession[] = [];
  for (const name of names) {
    const match = name.match(
      /^\.runtime-owned-process-session-([0-9a-f]{64})\.(?:(json)|(publish)\.tmp)$/u,
    );
    if (!match) throw new Error("Runtime process ownership storage is invalid.");
    if (match[3]) {
      // Session publication precedes registry admission, so a torn temporary
      // session cannot have authorized a child and is safe to discard.
      if (!discardDirectRuntimeJournalLeaf(root, name)) {
        throw new Error("Runtime process ownership storage could not be repaired.");
      }
      continue;
    }
    const leaf = readDirectRuntimeJournalLeaf(root, name, MAX_RECORD_BYTES);
    const session = leaf && parseSession(leaf.bytes);
    if (
      !session
      || generationHash(session.runtimeGenerationId) !== match[1]
    ) throw new Error("Runtime process ownership storage is invalid.");
    sessions.push(session);
  }
  if (sessions.length > MAX_SESSIONS) {
    throw new Error("The runtime process ownership session bound was exceeded.");
  }
  return sessions;
}

function removeLeaf(root: DirectRuntimeJournalRoot, name: string): boolean {
  const leaf = readDirectRuntimeJournalLeaf(root, name, MAX_RECORD_BYTES);
  return !leaf || unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity);
}

export class RuntimeOwnedProcessJournal {
  private readonly root: DirectRuntimeJournalRoot;
  readonly platform: NodeJS.Platform;
  private readonly darwinGuardianPath: string | null;
  private readonly darwinGuardianReadyReader: (
    pid: number,
  ) => DarwinProcessIdentity | null;

  constructor(
    dataDirectory: string,
    options: {
      readonly platform?: NodeJS.Platform;
      readonly darwinGuardianPath?: string;
      readonly readDarwinIdentity?: (pid: number) => DarwinProcessIdentity | null;
      readonly readDarwinGuardianReady?: (
        pid: number,
      ) => DarwinProcessIdentity | null;
    } = {},
  ) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
    this.platform = options.platform ?? process.platform;
    this.darwinGuardianPath = options.darwinGuardianPath ?? null;
    this.darwinGuardianReadyReader = options.readDarwinGuardianReady
      ?? options.readDarwinIdentity
      ?? ((pid) => this.darwinGuardianPath
        ? darwinProcessGuardianReady(pid, this.darwinGuardianPath)
        : null);
  }

  startSession(runtimeGenerationId: string, systemBootId: string): boolean {
    if (!supportedRuntimeOwnedProcessPlatform(this.platform)) return true;
    if (
      !validRuntimeGenerationId(runtimeGenerationId)
      || !validSystemBootId(systemBootId)
    ) return false;
    let sessions: RuntimeOwnedProcessSession[];
    try { sessions = readSessions(this.root); } catch { return false; }
    const existing = sessions.find((session) =>
      session.runtimeGenerationId === runtimeGenerationId);
    if (existing) return existing.systemBootId === systemBootId;
    if (sessions.length >= MAX_SESSIONS) return false;
    const name = sessionName(runtimeGenerationId);
    return writeDirectRuntimeJournalLeaf(
      this.root,
      `${SESSION_PREFIX}${generationHash(runtimeGenerationId)}.publish.tmp`,
      name,
      stored({ version: SCHEMA_VERSION, runtimeGenerationId, systemBootId }),
    );
  }

  armContainment(
    runtimeGenerationId: string,
    systemBootId: string,
    containment: RuntimeOwnedProcessContainment,
  ): boolean {
    if (this.platform !== "win32") return false;
    const sessions = (() => {
      try { return readSessions(this.root); } catch { return null; }
    })();
    const session = sessions?.find((candidate) =>
      candidate.runtimeGenerationId === runtimeGenerationId);
    if (!session || session.systemBootId !== systemBootId) return false;
    const name = containmentName(runtimeGenerationId);
    const current = readDirectRuntimeJournalLeaf(
      this.root,
      name,
      MAX_RECORD_BYTES,
    );
    if (current) {
      const parsed = parseContainment(
        current.bytes,
        runtimeGenerationId,
        systemBootId,
      );
      return parsed?.kind === containment.kind && parsed.name === containment.name;
    }
    return writeDirectRuntimeJournalLeaf(
      this.root,
      `${name}.publish.tmp`,
      name,
      stored({
        version: SCHEMA_VERSION,
        runtimeGenerationId,
        systemBootId,
        containment,
      }),
    );
  }

  containment(
    runtimeGenerationId: string,
  ): RuntimeOwnedProcessContainment | null | undefined {
    try {
      const session = readSessions(this.root).find((candidate) =>
        candidate.runtimeGenerationId === runtimeGenerationId);
      if (!session) return undefined;
      const canonical = containmentName(runtimeGenerationId);
      const temporary = `${canonical}.publish.tmp`;
      if (readDirectRuntimeJournalLeaf(this.root, temporary, MAX_RECORD_BYTES)) {
        if (!discardDirectRuntimeJournalLeaf(this.root, temporary)) return undefined;
      }
      const leaf = readDirectRuntimeJournalLeaf(
        this.root,
        canonical,
        MAX_RECORD_BYTES,
      );
      if (!leaf) return null;
      return parseContainment(
        leaf.bytes,
        runtimeGenerationId,
        session.systemBootId,
      ) ?? undefined;
    } catch {
      return undefined;
    }
  }

  begin(runtimeGenerationId: string, systemBootId: string): string {
    const ownershipId = randomUUID();
    if (!this.startSession(runtimeGenerationId, systemBootId)) {
      throw new Error("The runtime process ownership session is unavailable.");
    }
    const names = listDirectRuntimeJournalLeaves(
      this.root,
      CLAIM_PREFIX,
      MAX_CLAIMS * 4,
    );
    const active = names.filter((name) => name.endsWith(".json"));
    if (active.length >= MAX_CLAIMS) {
      throw new Error("The runtime process ownership bound was exceeded.");
    }
    const base: RuntimeOwnedProcessPendingBase = {
      version: SCHEMA_VERSION, state: "pending", ownershipId,
      runtimeGenerationId, systemBootId,
    };
    const pending: RuntimeOwnedProcessPending =
      this.platform === "darwin" && this.darwinGuardianPath
        ? { ...base, containment: "darwin-parent-watchdog-v1", runtimeParentPid: process.pid }
        : base;
    if (!writeDirectRuntimeJournalLeaf(
      this.root,
      temporaryClaimName(ownershipId, "begin"),
      claimName(ownershipId),
      stored(pending),
    )) throw new Error("The runtime process ownership intent could not be persisted.");
    return ownershipId;
  }

  claim(
    ownershipId: string,
    runtimeGenerationId: string,
    systemBootId: string,
    pid: number,
    expectedParentPid: number,
    options: {
      readonly spawnedAfterMs?: number;
      readonly spawnedBeforeMs?: number;
      readonly expectedDarwinIdentity?: DarwinProcessIdentity;
    } = {},
  ): RuntimeOwnedProcessClaim {
    if (!UUID_PATTERN.test(ownershipId)) {
      throw new Error("The runtime process ownership identity is invalid.");
    }
    const current = readDirectRuntimeJournalLeaf(
      this.root,
      claimName(ownershipId),
      MAX_RECORD_BYTES,
    );
    const pending = current && parseRecord(current.bytes);
    const linuxIdentity = this.platform === "linux"
      ? readLinuxProcessIdentity(pid)
      : null;
    const darwinIdentity = this.platform === "darwin"
      ? this.darwinGuardianReadyReader(pid)
      : null;
    const spawnedAfterMs = Math.max(
      0,
      Math.trunc(options.spawnedAfterMs ?? Date.now()),
    );
    const spawnedBeforeMs = Math.trunc(options.spawnedBeforeMs ?? Date.now());
    const windowsIdentity: WindowsProcessIdentity | null =
      this.platform === "win32"
        ? {
            platform: "win32",
            pid,
            processGroupId: null,
            startedAfterMs: spawnedAfterMs,
            startedBeforeMs: spawnedBeforeMs,
          }
        : null;
    const identity = linuxIdentity ?? darwinIdentity ?? windowsIdentity;
    if (
      pending?.state !== "pending"
      || pending.runtimeGenerationId !== runtimeGenerationId
      || pending.systemBootId !== systemBootId
      || !identity
      || (darwinIdentity && options.expectedDarwinIdentity
        && !sameProcess(options.expectedDarwinIdentity, darwinIdentity))
      || ("parentPid" in identity && identity.parentPid !== expectedParentPid)
      || identity.processGroupId !== (this.platform === "win32" ? null : pid)
      || (this.platform === "darwin"
        && "sessionId" in identity
        && identity.sessionId !== pid)
    ) throw new Error("The spawned process ownership could not be proven.");
    const claim: RuntimeOwnedProcessClaim = {
      version: pending.version,
      state: "owned",
      ownershipId: pending.ownershipId,
      runtimeGenerationId: pending.runtimeGenerationId,
      systemBootId: pending.systemBootId,
      process: identity,
    };
    if (!writeDirectRuntimeJournalLeaf(
      this.root,
      temporaryClaimName(ownershipId, "claim"),
      claimName(ownershipId),
      stored(claim),
    )) throw new Error("The spawned process ownership could not be persisted.");
    return claim;
  }

  release(ownershipId: string): boolean {
    if (!UUID_PATTERN.test(ownershipId)) return false;
    const canonical = claimName(ownershipId);
    const current = readDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      MAX_RECORD_BYTES,
    );
    if (!current || !parseRecord(current.bytes)) return false;
    const consuming = temporaryClaimName(ownershipId, "consume");
    return renameDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      consuming,
      current.identity,
    ) && removeLeaf(this.root, consuming);
  }

  records(runtimeGenerationId: string): RuntimeOwnedProcessRecord[] | null {
    try {
      const parsedSession = readSessions(this.root).find((session) =>
        session.runtimeGenerationId === runtimeGenerationId);
      if (!parsedSession) return null;
      const names = listDirectRuntimeJournalLeaves(
        this.root,
        CLAIM_PREFIX,
        MAX_CLAIMS * 4,
      );
      const records: RuntimeOwnedProcessRecord[] = [];
      for (const name of names) {
        const match = name.match(
          /^\.runtime-owned-child-([0-9a-f-]{36})\.(?:(json)|(begin|claim|consume)\.tmp)$/iu,
        );
        if (!match || !UUID_PATTERN.test(match[1]!)) return null;
        if (match[3] === "begin") {
          if (!discardDirectRuntimeJournalLeaf(this.root, name)) return null;
          continue;
        }
        if (match[3] === "consume") {
          if (!removeLeaf(this.root, name)) return null;
          continue;
        }
        if (match[3] === "claim") {
          // The canonical pending record is authoritative until the atomic
          // replacement; a torn update therefore remains visibly fail-closed.
          if (!discardDirectRuntimeJournalLeaf(this.root, name)) return null;
          continue;
        }
        const leaf = readDirectRuntimeJournalLeaf(
          this.root,
          name,
          MAX_RECORD_BYTES,
        );
        const record = leaf && parseRecord(leaf.bytes);
        if (!record || record.ownershipId !== match[1]) return null;
        if (record.runtimeGenerationId === runtimeGenerationId) {
          if (record.systemBootId !== parsedSession.systemBootId) return null;
          records.push(record);
        }
      }
      return records;
    } catch {
      return null;
    }
  }

  finishSession(runtimeGenerationId: string): boolean {
    if (!supportedRuntimeOwnedProcessPlatform(this.platform)) return true;
    const records = this.records(runtimeGenerationId);
    if (!records || records.length > 0) return false;
    const containment = containmentName(runtimeGenerationId);
    if (!removeLeaf(this.root, containment)) return false;
    return removeLeaf(this.root, sessionName(runtimeGenerationId));
  }

  clearPriorBootSessions(systemBootId: string): boolean {
    if (!supportedRuntimeOwnedProcessPlatform(this.platform)) return true;
    if (!validSystemBootId(systemBootId)) return false;
    if (systemBootId === "unavailable") return true;
    let sessions: RuntimeOwnedProcessSession[];
    try { sessions = readSessions(this.root); } catch { return false; }
    const prior = sessions.filter((session) => (
      session.systemBootId !== "unavailable"
      && session.systemBootId !== systemBootId
    ));
    for (const session of prior) {
      const records = this.records(session.runtimeGenerationId);
      if (!records) return false;
      for (const record of records) {
        if (!this.release(record.ownershipId)) return false;
      }
      if (!this.finishSession(session.runtimeGenerationId)) return false;
    }
    return true;
  }

  clearRuntimeGenerationAfterConfirmedReboot(
    runtimeGenerationId: string,
  ): boolean {
    if (!supportedRuntimeOwnedProcessPlatform(this.platform)) return true;
    if (!validRuntimeGenerationId(runtimeGenerationId)) return false;
    let sessions: RuntimeOwnedProcessSession[];
    try { sessions = readSessions(this.root); } catch { return false; }
    if (!sessions.some((session) =>
      session.runtimeGenerationId === runtimeGenerationId)) return true;
    const records = this.records(runtimeGenerationId);
    if (!records) return false;
    for (const record of records) {
      if (!this.release(record.ownershipId)) return false;
    }
    return this.finishSession(runtimeGenerationId);
  }

  static identityMatches(
    claim: RuntimeOwnedProcessClaim,
    identity: ObservedRuntimeOwnedProcessIdentity,
  ): boolean {
    return sameProcess(claim.process, identity);
  }
}

interface ActiveRuntimeOwnedProcessRegistry {
  readonly journal: RuntimeOwnedProcessJournal;
  readonly platform: RuntimeOwnedProcessPlatform;
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
  readonly darwinGuardianPath: string | null;
  readonly readDarwinIdentity: (
    pid: number,
  ) => DarwinProcessIdentity | null;
  readonly readDarwinGuardianReady: (
    pid: number,
  ) => DarwinProcessIdentity | null;
  readonly claims: WeakMap<ChildProcess, ActiveRuntimeOwnedProcessClaim>;
  readonly pendingReleaseConfirmations: Set<Promise<boolean>>;
}

interface ActiveRuntimeOwnedProcessClaim {
  readonly ownershipId: string;
  released: boolean;
  releaseConfirmation: Promise<boolean> | null;
  settleReleaseConfirmation: ((confirmed: boolean) => void) | null;
}

let activeRegistry: ActiveRuntimeOwnedProcessRegistry | null = null;

export function activateRuntimeOwnedProcessRegistry(
  dataDirectory: string,
  runtimeGenerationId: string,
  systemBootId: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly darwinGuardianPath?: string;
    readonly readDarwinIdentity?: (
      pid: number,
    ) => DarwinProcessIdentity | null;
    readonly readDarwinGuardianReady?: (
      pid: number,
    ) => DarwinProcessIdentity | null;
  } = {},
): (() => void) | null {
  const platform = options.platform ?? process.platform;
  if (!supportedRuntimeOwnedProcessPlatform(platform)) return null;
  if (activeRegistry) {
    throw new Error("The runtime process ownership registry is already active.");
  }
  const darwinGuardianPath = options.darwinGuardianPath ?? null;
  if (
    platform === "darwin"
    && (!darwinGuardianPath || !isAbsolute(darwinGuardianPath))
  ) throw new Error("The macOS runtime process guardian is unavailable.");
  const journal = new RuntimeOwnedProcessJournal(dataDirectory, {
    platform,
    ...(darwinGuardianPath ? { darwinGuardianPath } : {}),
    ...(options.readDarwinIdentity
      ? { readDarwinIdentity: options.readDarwinIdentity }
      : {}),
    ...(options.readDarwinGuardianReady
      ? { readDarwinGuardianReady: options.readDarwinGuardianReady }
      : {}),
  });
  if (!journal.startSession(runtimeGenerationId, systemBootId)) {
    throw new Error("The runtime process ownership session could not be persisted.");
  }
  const registry: ActiveRuntimeOwnedProcessRegistry = {
    journal,
    platform,
    runtimeGenerationId,
    systemBootId,
    darwinGuardianPath,
    readDarwinIdentity: options.readDarwinIdentity
      ?? ((pid) => darwinGuardianPath
        ? readDarwinProcessIdentity(pid, darwinGuardianPath)
        : null),
    readDarwinGuardianReady: options.readDarwinGuardianReady
      ?? ((pid) => darwinGuardianPath
        ? darwinProcessGuardianReady(pid, darwinGuardianPath)
        : null),
    claims: new WeakMap(),
    pendingReleaseConfirmations: new Set(),
  };
  activeRegistry = registry;
  return () => {
    if (activeRegistry === registry) activeRegistry = null;
  };
}

export interface RuntimeOwnedProcessInvocation {
  readonly command: string;
  readonly args: string[];
}

/**
 * Places every macOS runtime child inside the native guardian's private
 * process session. The helper execs the requested program without a shell;
 * the guardian stays alive until every process in that session is drained.
 */
export function runtimeOwnedProcessInvocation(
  command: string,
  args: readonly string[],
): RuntimeOwnedProcessInvocation {
  const registry = activeRegistry;
  if (registry?.platform !== "darwin") {
    return { command, args: [...args] };
  }
  if (!registry.darwinGuardianPath) {
    throw new Error("The macOS runtime process guardian is unavailable.");
  }
  return {
    command: registry.darwinGuardianPath,
    args: ["watch", String(process.pid), "--", command, ...args],
  };
}

export function activeRuntimeOwnedProcessPlatform(): RuntimeOwnedProcessPlatform | null {
  return activeRegistry?.platform ?? null;
}

function hardStopUnclaimed(
  child: Pick<ChildProcess, "pid" | "kill">,
  platform: NodeJS.Platform,
): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { /* The group may be gone. */ }
  }
  try { child.kill("SIGKILL"); } catch { /* The child may be gone. */ }
}

function hardStopUnclaimedDarwinGuardian(
  child: Pick<ChildProcess, "pid" | "kill">,
  registry: ActiveRuntimeOwnedProcessRegistry,
  expectedIdentity: DarwinProcessIdentity | null,
): void {
  const pid = child.pid;
  if (!pid || !expectedIdentity || !registry.darwinGuardianPath) return;
  let current: DarwinProcessIdentity | null = null;
  try {
    current = registry.readDarwinIdentity(pid);
  } catch {
    return;
  }
  if (!current || !sameProcess(expectedIdentity, current)) return;
  try { child.kill("SIGKILL"); } catch { /* The exact guardian may be gone. */ }
}

function exactPendingClaim(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
): boolean {
  const records = registry.journal.records(registry.runtimeGenerationId);
  if (!records) return false;
  const matching = records.filter((record) =>
    record.ownershipId === ownershipId);
  return matching.length === 1
    && matching[0]?.state === "pending"
    && matching[0].runtimeGenerationId === registry.runtimeGenerationId
    && matching[0].systemBootId === registry.systemBootId;
}

function defaultSettleWait(durationMs: number): void {
  Atomics.wait(
    PID_PROCESS_GROUP_SETTLE_SIGNAL,
    0,
    0,
    durationMs,
  );
}

interface RuntimeOwnedPidProcessOptions {
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => void;
  readonly readIdentity?: (pid: number) => LinuxProcessIdentity | null;
  readonly processCanExecute?: (pid: number) => boolean | null;
  readonly darwinGuardianCommand?: string;
}

function claimPidProcessAfterGroupSettle(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
  pid: number,
  options: RuntimeOwnedPidProcessOptions,
): RuntimeOwnedProcessClaim {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultSettleWait;
  const readIdentity = options.readIdentity ?? readLinuxProcessIdentity;
  const deadlineAt = now() + PID_PROCESS_GROUP_SETTLE_WAIT_MS;
  while (true) {
    if (!exactPendingClaim(registry, ownershipId)) {
      throw new Error("The spawned process ownership intent changed.");
    }
    const identity = readIdentity(pid);
    if (
      !identity
      || identity.pid !== pid
      || identity.parentPid !== process.pid
    ) throw new Error("The spawned process identity could not be proven.");
    if (identity.processGroupId === pid) {
      try {
        return registry.journal.claim(
          ownershipId,
          registry.runtimeGenerationId,
          registry.systemBootId,
          pid,
          process.pid,
        );
      } catch (error) {
        if (!exactPendingClaim(registry, ownershipId)) throw error;
        const current = readIdentity(pid);
        if (
          !current
          || current.pid !== pid
          || current.parentPid !== process.pid
          || current.processGroupId === pid
        ) throw error;
      }
    }
    const remainingMs = Math.trunc(deadlineAt - now());
    if (remainingMs <= 0) {
      throw new Error("The spawned process group identity did not settle.");
    }
    wait(Math.max(
      1,
      Math.min(PID_PROCESS_GROUP_SETTLE_POLL_MS, remainingMs),
    ));
  }
}

function releaseFailedPidClaimIfStopped(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
  processCanExecute: (pid: number) => boolean | null,
): Promise<boolean> {
  if (claim.releaseConfirmation) return claim.releaseConfirmation;
  let settleConfirmation!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => {
    settleConfirmation = resolve;
  });
  claim.releaseConfirmation = confirmation;
  claim.settleReleaseConfirmation = settleConfirmation;
  registry.pendingReleaseConfirmations.add(confirmation);
  void confirmation.then(() => {
    registry.pendingReleaseConfirmations.delete(confirmation);
    claim.settleReleaseConfirmation = null;
  });
  const deadlineAt = Date.now() + PROCESS_GROUP_EXIT_WAIT_MS;
  const poll = (): void => {
    if (
      activeRegistry !== registry
      || claim.released
      || !exactPendingClaim(registry, claim.ownershipId)
    ) {
      settleConfirmation(claim.released);
      return;
    }
    const executable = processCanExecute(pid);
    if (executable === false && exactProcessGroupAbsent(pid) === true) {
      try {
        settleConfirmation(releaseActiveClaim(registry, claim));
      } catch {
        settleConfirmation(false);
      }
      return;
    }
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) {
      settleConfirmation(false);
      return;
    }
    const timer = setTimeout(
      poll,
      Math.max(1, Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs)),
    );
    timer.unref();
  };
  poll();
  return confirmation;
}

function releaseIfGroupExited(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
): Promise<boolean> {
  if (claim.releaseConfirmation) return claim.releaseConfirmation;
  if (claim.released) return Promise.resolve(true);
  let settleConfirmation!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => {
    settleConfirmation = resolve;
  });
  claim.releaseConfirmation = confirmation;
  claim.settleReleaseConfirmation = settleConfirmation;
  registry.pendingReleaseConfirmations.add(confirmation);
  void confirmation.then(() => {
    registry.pendingReleaseConfirmations.delete(confirmation);
    claim.settleReleaseConfirmation = null;
  });
  const deadlineAt = Date.now() + PROCESS_GROUP_EXIT_WAIT_MS;
  const poll = (): void => {
    if (activeRegistry !== registry) {
      settleConfirmation(false);
      return;
    }
    if (claim.released) {
      settleConfirmation(true);
      return;
    }
    try {
      const containmentAbsent = registry.platform === "darwin"
        ? Boolean(
            registry.darwinGuardianPath
            && darwinProcessSessionEmpty(pid, registry.darwinGuardianPath),
          )
        : exactProcessGroupAbsent(pid) === true;
      if (containmentAbsent) {
        try {
          if (!releaseActiveClaim(registry, claim)) settleConfirmation(false);
        } catch {
          // A removed test/runtime root cannot authorize further mutation.
          settleConfirmation(false);
        }
        return;
      }
    } catch {
      // An unreadable containment boundary remains durably owned.
    }
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) {
      settleConfirmation(false);
      return;
    }
    const timer = setTimeout(
      poll,
      Math.max(1, Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs)),
    );
    timer.unref();
  };
  poll();
  return confirmation;
}

function releaseActiveClaim(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
): boolean {
  if (claim.released) return true;
  if (!registry.journal.release(claim.ownershipId)) return false;
  claim.released = true;
  claim.settleReleaseConfirmation?.(true);
  return true;
}

function authorizeDarwinGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  durableClaim: RuntimeOwnedProcessClaim,
): void {
  if (registry.platform !== "darwin") return;
  if (
    !("platform" in durableClaim.process)
    || durableClaim.process.platform !== "darwin"
    || !registry.darwinGuardianPath
  ) throw new Error("The macOS owned process guardian is invalid.");
  const identity = registry.readDarwinIdentity(durableClaim.process.pid);
  if (
    !identity
    || !RuntimeOwnedProcessJournal.identityMatches(durableClaim, identity)
  ) throw new Error("The macOS owned process guardian identity changed.");
  process.kill(identity.pid, "SIGUSR1");
}

export function spawnRuntimeOwnedProcess<T extends ChildProcess>(
  spawnProcess: () => T,
): T {
  const registry = activeRegistry;
  if (!registry) return spawnProcess();
  const ownershipId = registry.journal.begin(
    registry.runtimeGenerationId,
    registry.systemBootId,
  );
  const spawnedAfterMs = Date.now();
  let child: T;
  try {
    child = spawnProcess();
    if (
      registry.platform === "darwin"
      && child.spawnfile !== registry.darwinGuardianPath
    ) throw new Error("The macOS owned process did not use its guardian.");
  } catch (error) {
    registry.journal.release(ownershipId);
    throw error;
  }
  const claim: ActiveRuntimeOwnedProcessClaim = {
    ownershipId,
    released: false,
    releaseConfirmation: null,
    settleReleaseConfirmation: null,
  };
  let darwinGuardianIdentity: DarwinProcessIdentity | null = null;
  try {
    if (registry.platform === "darwin" && registry.darwinGuardianPath) {
      darwinGuardianIdentity = registry.readDarwinGuardianReady(child.pid ?? 0);
      if (!darwinGuardianIdentity) {
        throw new Error("The macOS owned process guardian is not ready.");
      }
    }
    const durableClaim = registry.journal.claim(
      ownershipId,
      registry.runtimeGenerationId,
      registry.systemBootId,
      child.pid ?? 0,
      process.pid,
      {
        spawnedAfterMs,
        spawnedBeforeMs: Date.now(),
        ...(darwinGuardianIdentity
          ? { expectedDarwinIdentity: darwinGuardianIdentity }
          : {}),
      },
    );
    authorizeDarwinGuardian(registry, durableClaim);
    registry.claims.set(child, claim);
    child.once("close", (_code, signal) => {
      // The guardian handles normal stop signals itself and reports payload
      // signals as numeric exit statuses. A signal on the guardian process is
      // therefore an unambiguous unproved-containment marker (or an external
      // hard kill); retain the durable claim for explicit recovery.
      if (registry.platform === "darwin" && typeof signal === "string") return;
      if (registry.platform === "win32") {
        try { releaseActiveClaim(registry, claim); } catch {
          // The durable claim remains for startup recovery.
        }
      } else {
        void releaseIfGroupExited(registry, claim, child.pid ?? 0);
      }
    });
  } catch (error) {
    if (child.pid === undefined) registry.journal.release(ownershipId);
    else {
      if (registry.platform === "darwin") {
        hardStopUnclaimedDarwinGuardian(
          child,
          registry,
          darwinGuardianIdentity,
        );
      } else hardStopUnclaimed(child, registry.platform);
      const processCanExecute = failedClaimProcessCanExecute(
        registry.platform, registry.darwinGuardianPath, PROCESS_GROUP_EXIT_WAIT_MS,
      );
      if (processCanExecute) {
        void releaseFailedPidClaimIfStopped(
          registry,
          claim,
          child.pid,
          processCanExecute,
        );
      }
    }
    throw error;
  }
  return child;
}

export interface RuntimeOwnedPidProcess<T> {
  readonly process: T;
  confirmStopped(): boolean;
  releaseIfGroupExited(exitSignal?: number): void;
}

export function spawnRuntimeOwnedPidProcess<T extends { readonly pid: number }>(
  spawnProcess: () => T,
  options: RuntimeOwnedPidProcessOptions = {},
): RuntimeOwnedPidProcess<T> {
  const registry = activeRegistry;
  if (!registry) {
    return {
      process: spawnProcess(),
      confirmStopped: () => true,
      releaseIfGroupExited: () => undefined,
    };
  }
  const ownershipId = registry.journal.begin(
    registry.runtimeGenerationId,
    registry.systemBootId,
  );
  const claim: ActiveRuntimeOwnedProcessClaim = {
    ownershipId,
    released: false,
    releaseConfirmation: null,
    settleReleaseConfirmation: null,
  };
  let owned: T | null = null;
  let darwinGuardianIdentity: DarwinProcessIdentity | null = null;
  const spawnedAfterMs = Date.now();
  try {
    owned = spawnProcess();
    if (
      registry.platform === "darwin"
      && options.darwinGuardianCommand !== registry.darwinGuardianPath
    ) throw new Error("The macOS owned process did not use its guardian.");
    if (registry.platform === "linux") {
      claimPidProcessAfterGroupSettle(
        registry,
        ownershipId,
        owned.pid,
        options,
      );
    } else {
      if (registry.platform === "darwin" && registry.darwinGuardianPath) {
        darwinGuardianIdentity = registry.readDarwinGuardianReady(owned.pid);
        if (!darwinGuardianIdentity) {
          throw new Error("The macOS owned process guardian is not ready.");
        }
      }
      const durableClaim = registry.journal.claim(
        ownershipId,
        registry.runtimeGenerationId,
        registry.systemBootId,
        owned.pid,
        process.pid,
        {
          spawnedAfterMs,
          spawnedBeforeMs: Date.now(),
          ...(darwinGuardianIdentity
            ? { expectedDarwinIdentity: darwinGuardianIdentity }
            : {}),
        },
      );
      authorizeDarwinGuardian(registry, durableClaim);
    }
  } catch (error) {
    if (owned) {
      const failedOwned = owned;
      const unclaimed = {
        pid: failedOwned.pid,
        kill: () => {
          try { process.kill(failedOwned.pid, "SIGKILL"); } catch { /* Gone. */ }
          return true;
        },
      };
      if (registry.platform === "darwin") {
        hardStopUnclaimedDarwinGuardian(
          unclaimed,
          registry,
          darwinGuardianIdentity,
        );
      } else hardStopUnclaimed(unclaimed, registry.platform);
      const processCanExecute = failedClaimProcessCanExecute(
        registry.platform, registry.darwinGuardianPath, PROCESS_GROUP_EXIT_WAIT_MS,
      );
      if (processCanExecute) {
        void releaseFailedPidClaimIfStopped(
          registry,
          claim,
          failedOwned.pid,
          options.processCanExecute ?? processCanExecute,
        );
      }
    } else registry.journal.release(ownershipId);
    throw error;
  }
  const confirmedOwned = owned;
  return {
    process: confirmedOwned,
    confirmStopped: () => releaseActiveClaim(registry, claim),
    releaseIfGroupExited: (exitSignal) => {
      if (registry.platform === "win32") {
        try { releaseActiveClaim(registry, claim); } catch {
          // The durable claim remains for startup recovery.
        }
      } else if (
        registry.platform === "darwin"
        && typeof exitSignal === "number"
        && exitSignal > 0
      ) {
        // A guardian-level signal is the unproved-containment marker. Do not
        // let a now-empty private session erase evidence of a detached child.
        return;
      } else {
        void releaseIfGroupExited(registry, claim, confirmedOwned.pid);
      }
    },
  };
}

export function confirmRuntimeOwnedProcessStopped(child: ChildProcess): boolean {
  const registry = activeRegistry;
  const claim = registry?.claims.get(child);
  return registry && claim ? releaseActiveClaim(registry, claim) : true;
}

export function runtimeOwnedProcessCleanupConfirmed(): boolean {
  if (!activeRegistry) {
    return !supportedRuntimeOwnedProcessPlatform(process.platform);
  }
  const records = activeRegistry.journal.records(
    activeRegistry.runtimeGenerationId,
  );
  return records !== null && records.length === 0;
}

export async function awaitRuntimeOwnedProcessCleanupConfirmed(): Promise<boolean> {
  const registry = activeRegistry;
  if (!registry) return !supportedRuntimeOwnedProcessPlatform(process.platform);
  while (activeRegistry === registry) {
    const closing = [...registry.pendingReleaseConfirmations];
    if (closing.length === 0) break;
    await Promise.all(closing);
  }
  if (activeRegistry !== registry) return false;
  return runtimeOwnedProcessCleanupConfirmed();
}
