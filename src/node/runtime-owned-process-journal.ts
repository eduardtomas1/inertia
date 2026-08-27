import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { validRuntimeGenerationId, validSystemBootId } from "./runtime-process-protocol.js";
import {
  darwinProcessGuardianReady,
  type DarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";
import { readLinuxGuardianReady } from "./runtime-owned-process-linux.js";

const CLAIM_PREFIX = ".runtime-owned-child-";
const SESSION_PREFIX = ".runtime-owned-process-session-";
const CONTAINMENT_PREFIX = ".runtime-owned-process-containment-";
const MAX_CLAIMS = 256;
const MAX_SESSIONS = 32;
const MAX_RECORD_BYTES = 768;
const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
export interface RuntimeOwnedLinuxProcessPending extends RuntimeOwnedProcessPendingBase {
  readonly containment: "linux-parent-gated-v1";
  readonly runtimeParentPid: number;
  readonly runtimeParentStartTimeTicks: string;
}
interface RuntimeOwnedLegacyProcessPending extends RuntimeOwnedProcessPendingBase {
  readonly containment?: never;
  readonly runtimeParentPid?: never;
}
type RuntimeOwnedProcessPending = RuntimeOwnedDarwinProcessPending
  | RuntimeOwnedLinuxProcessPending
  | RuntimeOwnedLegacyProcessPending;

export interface RuntimeOwnedProcessClaim extends RuntimeOwnedProcessSession {
  readonly state: "preauth" | "owned" | "retiring";
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
  operation: "begin" | "claim" | "retire" | "consume",
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
      && validPid(identity.pid)
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

function readCurrentLinuxStartTimeTicks(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    if (stat.length < 1 || stat.length > 16_384) return null;
    const closingName = stat.lastIndexOf(")");
    if (closingName < 2) return null;
    const fields = stat.slice(closingName + 2).trim().split(/\s+/u);
    return validTicks(fields[19]) ? fields[19]! : null;
  } catch { return null; }
}

export function sameProcess(
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
    const pending: RuntimeOwnedProcessPending = this.platform === "linux"
      && this.darwinGuardianPath
      ? (() => {
          const parentStartTimeTicks = readCurrentLinuxStartTimeTicks();
          if (!parentStartTimeTicks) throw new Error("The runtime process parent identity is unavailable.");
          return {
            ...base,
            containment: "linux-parent-gated-v1" as const,
            runtimeParentPid: process.pid,
            runtimeParentStartTimeTicks: parentStartTimeTicks,
          };
        })()
      : this.platform === "darwin" && this.darwinGuardianPath
      ? {
          ...base,
          containment: "darwin-parent-watchdog-v1",
          runtimeParentPid: process.pid,
        }
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
      readonly expectedLinuxIdentity?: LinuxProcessIdentity;
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
    const linuxIdentity = this.platform === "linux" && this.darwinGuardianPath
      ? options.expectedLinuxIdentity
        ?? readLinuxGuardianReady(pid, this.darwinGuardianPath, expectedParentPid)
      : null;
    const currentLinuxIdentity = linuxIdentity && options.expectedLinuxIdentity
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
      || (linuxIdentity && options.expectedLinuxIdentity
        && (!currentLinuxIdentity
          || currentLinuxIdentity.parentPid !== expectedParentPid
          || !sameProcess(linuxIdentity, currentLinuxIdentity)))
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
      state: this.platform === "linux" ? "preauth" : "owned",
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

  own(ownershipId: string): RuntimeOwnedProcessClaim | null {
    if (!UUID_PATTERN.test(ownershipId)) return null;
    const current = readDirectRuntimeJournalLeaf(this.root, claimName(ownershipId), MAX_RECORD_BYTES);
    const preauth = current && parseRecord(current.bytes);
    if (!preauth || preauth.state !== "preauth") return null;
    const owned: RuntimeOwnedProcessClaim = { ...preauth, state: "owned" };
    return writeDirectRuntimeJournalLeaf(
      this.root,
      temporaryClaimName(ownershipId, "claim"),
      claimName(ownershipId),
      stored(owned),
    ) ? owned : null;
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

  releaseRetiring(ownershipId: string): boolean {
    if (!UUID_PATTERN.test(ownershipId)) return false;
    const current = readDirectRuntimeJournalLeaf(this.root, claimName(ownershipId), MAX_RECORD_BYTES);
    const record = current && parseRecord(current.bytes);
    return record?.state === "retiring" && this.release(ownershipId);
  }

  retire(ownershipId: string): boolean {
    const canonical = claimName(ownershipId);
    const current = readDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      MAX_RECORD_BYTES,
    );
    const record = current && parseRecord(current.bytes);
    if (!current || record?.state !== "owned") {
      return record?.state === "retiring";
    }
    const retiring: RuntimeOwnedProcessClaim = { ...record, state: "retiring" };
    return writeDirectRuntimeJournalLeaf(
      this.root,
      temporaryClaimName(ownershipId, "retire"),
      canonical,
      stored(retiring),
    );
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
          /^\.runtime-owned-child-([0-9a-f-]{36})\.(?:(json)|(begin|claim|retire|consume)\.tmp)$/iu,
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
        if (match[3] === "claim" || match[3] === "retire") {
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
