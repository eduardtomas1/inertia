import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  directRuntimeJournalRootIsEmpty,
  discardDirectRuntimeJournalLeaf,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalChildRoot,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  removeDirectRuntimeJournalChildRoot,
  renameDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeafFromRoot,
  type DirectRuntimeJournalRoot,
} from "./direct-runtime-journal.js";
import { validRuntimeGenerationId, validSystemBootId } from "./runtime-process-protocol.js";
import {
  RUNTIME_OWNED_PROCESS_SESSION_VERSION,
  RuntimeOwnedProcessSessionJournal,
  runtimeOwnedProcessRetiringSessionName,
  runtimeOwnedProcessRetiringWriterName,
  runtimeOwnedProcessWriterName,
  type RuntimeOwnedProcessSession,
  type RuntimeOwnedProcessSessionCapability,
  type StoredRuntimeOwnedProcessSessionLeaf,
} from "./runtime-owned-process-session-journal.js";
export type {
  RuntimeOwnedProcessSession,
  RuntimeOwnedProcessSessionCapability,
} from "./runtime-owned-process-session-journal.js";
import {
  darwinProcessGuardianReady,
  type DarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";
import { readLinuxGuardianReady } from "./runtime-owned-process-linux.js";

const CLAIM_PREFIX = ".runtime-owned-child-";
const CONTAINMENT_PREFIX = ".runtime-owned-process-containment-";
const MAX_CLAIMS = 256;
const MAX_RECORD_BYTES = 768;
const SCHEMA_VERSION = RUNTIME_OWNED_PROCESS_SESSION_VERSION;
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

export type RuntimeOwnedProcessRecord =
  RuntimeOwnedProcessPending | RuntimeOwnedProcessClaim;

export interface RuntimeOwnedProcessGenerationInspection {
  readonly session: RuntimeOwnedProcessSession | null;
  readonly sessionState: "active" | "retiring" | null;
  readonly sessionWriterPresent: boolean;
  readonly records: readonly RuntimeOwnedProcessRecord[];
  readonly consumingRecords: readonly RuntimeOwnedProcessRecord[];
  readonly containment: RuntimeOwnedProcessContainment | null;
}

function generationHash(runtimeGenerationId: string): string {
  return createHash("sha256").update(runtimeGenerationId).digest("hex");
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

export function parseRuntimeOwnedProcessRecordLeaf(
  bytes: Buffer,
  expectedOwnershipId: string,
): RuntimeOwnedProcessRecord | null {
  const record = parseRecord(bytes);
  return record
    && UUID_PATTERN.test(expectedOwnershipId)
    && record.ownershipId.toLowerCase() === expectedOwnershipId.toLowerCase()
    ? record
    : null;
}

export function parseRuntimeOwnedProcessContainmentLeaf(
  bytes: Buffer,
  expectedGenerationHash: string,
): {
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
} | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const stored = value as Partial<StoredRuntimeOwnedProcessContainment>;
    if (
      !validRuntimeGenerationId(stored.runtimeGenerationId)
      || !validSystemBootId(stored.systemBootId)
      || generationHash(stored.runtimeGenerationId) !== expectedGenerationHash
      || !parseContainment(
        bytes,
        stored.runtimeGenerationId,
        stored.systemBootId,
      )
    ) return null;
    return {
      runtimeGenerationId: stored.runtimeGenerationId,
      systemBootId: stored.systemBootId,
    };
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

function removeLeaf(root: DirectRuntimeJournalRoot, name: string): boolean {
  const leaf = readDirectRuntimeJournalLeaf(root, name, MAX_RECORD_BYTES);
  return !leaf || unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity);
}

function settleSessionWriter(entry: StoredRuntimeOwnedProcessSessionLeaf): boolean {
  if (!entry.writerRoot) return entry.state === "retiring";
  const names = listDirectRuntimeJournalLeaves(
    entry.writerRoot,
    ".runtime-owned-",
    MAX_CLAIMS * 3 + 1,
  );
  for (const name of names) {
    const claim = name.match(
      /^\.runtime-owned-child-([0-9a-f-]{36})\.(?:begin|claim|retire)\.tmp$/iu,
    );
    const containment = name === `${containmentName(
      entry.session.runtimeGenerationId,
    )}.publish.tmp`;
    if ((!claim || !UUID_PATTERN.test(claim[1]!)) && !containment) return false;
    if (entry.state === "retiring" && claim) {
      // Renaming the writer directory fences every delayed publisher before
      // recovery enters here. An exact child-claim temporary was never
      // committed to the canonical journal, so even a crash-partial payload is
      // safe to discard by pinned identity. A containment temporary must still
      // authenticate its complete payload before it can be removed.
      if (!discardDirectRuntimeJournalLeaf(entry.writerRoot, name)) return false;
      continue;
    }
    const leaf = readDirectRuntimeJournalLeaf(
      entry.writerRoot,
      name,
      MAX_RECORD_BYTES,
    );
    if (!leaf) return false;
    if (claim) {
      const record = parseRecord(leaf.bytes);
      if (
        !record
        || record.ownershipId !== claim[1]
        || record.runtimeGenerationId !== entry.session.runtimeGenerationId
        || record.systemBootId !== entry.session.systemBootId
      ) return false;
    } else if (!parseContainment(
      leaf.bytes,
      entry.session.runtimeGenerationId,
      entry.session.systemBootId,
    )) return false;
    if (entry.state === "retiring") {
      if (!unlinkDirectRuntimeJournalLeaf(
        entry.writerRoot,
        name,
        leaf.identity,
      )) return false;
      continue;
    }
  }
  // The canonical record remains authoritative until the cross-directory
  // rename commits. A validated active temporary is therefore observable but
  // never repaired in place. A retiring writer was settled in the loop above.
  return true;
}

export class RuntimeOwnedProcessJournal {
  private readonly root: DirectRuntimeJournalRoot;
  private readonly sessions: RuntimeOwnedProcessSessionJournal;
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
    this.sessions = new RuntimeOwnedProcessSessionJournal(this.root);
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
    try { return this.sessions.start(runtimeGenerationId, systemBootId); } catch { return false; }
  }

  repairSessionCrashPrefixes(): boolean {
    return this.sessions.repairCrashPrefixes();
  }

  repairUnleasedEmptySessions(
    leasedRuntimeGenerationIds: ReadonlySet<string>,
  ): boolean {
    if (
      leasedRuntimeGenerationIds.size > 33
      || [...leasedRuntimeGenerationIds].some((runtimeGenerationId) =>
        !validRuntimeGenerationId(runtimeGenerationId))
    ) return false;
    try {
      const unleased = this.sessions.all().filter(({ session }) =>
        !leasedRuntimeGenerationIds.has(session.runtimeGenerationId));
      for (const entry of unleased) {
        if (
          (entry.state === "active" && !entry.writerRoot)
          || (entry.writerRoot
            && !directRuntimeJournalRootIsEmpty(entry.writerRoot))
        ) return false;
        const inspection = this.inspectGeneration(
          entry.session.runtimeGenerationId,
        );
        if (
          !inspection
          || inspection.sessionState !== entry.state
          || !inspection.session
          || JSON.stringify(inspection.session)
            !== JSON.stringify(entry.session)
          || inspection.records.length > 0
          || inspection.consumingRecords.length > 0
          || inspection.containment !== null
        ) return false;
        if (!this.finishSessionExact(entry.session)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  sessionExact(
    runtimeGenerationId: string,
  ): RuntimeOwnedProcessSession | null | undefined {
    return this.sessions.exact(runtimeGenerationId);
  }

  sessionCapability(
    runtimeGenerationId: string,
    systemBootId: string,
  ): RuntimeOwnedProcessSessionCapability | null {
    return this.sessions.capability(runtimeGenerationId, systemBootId);
  }

  sessionCapabilityCurrent(
    capability: RuntimeOwnedProcessSessionCapability,
  ): boolean {
    return this.sessions.capabilityCurrent(capability);
  }

  fenceSessionExact(expected: RuntimeOwnedProcessSession): boolean {
    if (!supportedRuntimeOwnedProcessPlatform(this.platform)) return true;
    try { return this.sessions.fence(expected); } catch { return false; }
  }

  private writerCapability(
    runtimeGenerationId: string,
    systemBootId: string,
    supplied?: RuntimeOwnedProcessSessionCapability,
  ): RuntimeOwnedProcessSessionCapability | null {
    const capability = supplied
      ?? this.sessionCapability(runtimeGenerationId, systemBootId);
    return capability
      && capability.session.runtimeGenerationId === runtimeGenerationId
      && capability.session.systemBootId === systemBootId
      && this.sessionCapabilityCurrent(capability)
      ? capability
      : null;
  }

  private publishForSession(
    capability: RuntimeOwnedProcessSessionCapability,
    temporaryName: string,
    targetName: string,
    bytes: Buffer,
  ): boolean {
    return writeDirectRuntimeJournalLeafFromRoot(
      capability.writerRoot,
      temporaryName,
      this.root,
      targetName,
      bytes,
    );
  }

  armContainment(
    runtimeGenerationId: string,
    systemBootId: string,
    containment: RuntimeOwnedProcessContainment,
  ): boolean {
    if (this.platform !== "win32") return false;
    const sessions = (() => {
      try { return this.sessions.all().map(({ session }) => session); } catch { return null; }
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
    const capability = this.writerCapability(runtimeGenerationId, systemBootId);
    return !!capability && this.publishForSession(
      capability,
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
      const entry = this.sessions.all().find(({ session }) =>
        session.runtimeGenerationId === runtimeGenerationId);
      if (!entry || !settleSessionWriter(entry)) return undefined;
      const session = entry.session;
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

  begin(
    runtimeGenerationId: string,
    systemBootId: string,
    suppliedCapability: RuntimeOwnedProcessSessionCapability,
  ): string {
    const ownershipId = randomUUID();
    const capability = this.writerCapability(
      runtimeGenerationId,
      systemBootId,
      suppliedCapability,
    );
    if (!capability) {
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
    if (!this.publishForSession(
      capability,
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
      readonly observedDarwinIdentity?: DarwinProcessIdentity;
      readonly expectedLinuxIdentity?: LinuxProcessIdentity;
      readonly sessionCapability?: RuntimeOwnedProcessSessionCapability;
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
      ? options.observedDarwinIdentity ?? this.darwinGuardianReadyReader(pid)
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
    const capability = this.writerCapability(
      runtimeGenerationId,
      systemBootId,
      options.sessionCapability,
    );
    if (!capability) {
      throw new Error("The runtime process ownership session retired during admission.");
    }
    if (!this.publishForSession(
      capability,
      temporaryClaimName(ownershipId, "claim"),
      claimName(ownershipId),
      stored(claim),
    )) throw new Error("The spawned process ownership could not be persisted.");
    return claim;
  }

  own(
    ownershipId: string,
    sessionCapability?: RuntimeOwnedProcessSessionCapability,
  ): RuntimeOwnedProcessClaim | null {
    if (!UUID_PATTERN.test(ownershipId)) return null;
    const current = readDirectRuntimeJournalLeaf(this.root, claimName(ownershipId), MAX_RECORD_BYTES);
    const preauth = current && parseRecord(current.bytes);
    if (!preauth || preauth.state !== "preauth") return null;
    const owned: RuntimeOwnedProcessClaim = { ...preauth, state: "owned" };
    const capability = this.writerCapability(
      preauth.runtimeGenerationId,
      preauth.systemBootId,
      sessionCapability,
    );
    if (!capability) return null;
    const written = this.publishForSession(
      capability,
      temporaryClaimName(ownershipId, "claim"),
      claimName(ownershipId),
      stored(owned),
    );
    if (!written) return null;
    return owned;
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
    ) && unlinkDirectRuntimeJournalLeaf(
      this.root,
      consuming,
      current.identity,
    );
  }

  releaseExact(expected: RuntimeOwnedProcessRecord): boolean {
    if (!UUID_PATTERN.test(expected.ownershipId)) return false;
    const canonical = claimName(expected.ownershipId);
    const current = readDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      MAX_RECORD_BYTES,
    );
    const parsed = current && parseRecord(current.bytes);
    if (
      !current
      || !parsed
      || JSON.stringify(parsed) !== JSON.stringify(expected)
    ) return false;
    const consuming = temporaryClaimName(expected.ownershipId, "consume");
    return renameDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      consuming,
      current.identity,
    ) && unlinkDirectRuntimeJournalLeaf(
      this.root,
      consuming,
      current.identity,
    );
  }

  releaseConsumingExact(expected: RuntimeOwnedProcessRecord): boolean {
    if (!UUID_PATTERN.test(expected.ownershipId)) return false;
    const consuming = temporaryClaimName(expected.ownershipId, "consume");
    const current = readDirectRuntimeJournalLeaf(
      this.root,
      consuming,
      MAX_RECORD_BYTES,
    );
    const parsed = current && parseRecord(current.bytes);
    return !!current
      && !!parsed
      && JSON.stringify(parsed) === JSON.stringify(expected)
      && unlinkDirectRuntimeJournalLeaf(
        this.root,
        consuming,
        current.identity,
      );
  }

  releaseRetiring(ownershipId: string): boolean {
    if (!UUID_PATTERN.test(ownershipId)) return false;
    const current = readDirectRuntimeJournalLeaf(this.root, claimName(ownershipId), MAX_RECORD_BYTES);
    const record = current && parseRecord(current.bytes);
    return record?.state === "retiring" && this.release(ownershipId);
  }

  retire(
    ownershipId: string,
    sessionCapability?: RuntimeOwnedProcessSessionCapability,
  ): boolean {
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
    const capability = this.writerCapability(
      record.runtimeGenerationId,
      record.systemBootId,
      sessionCapability,
    );
    if (!capability) return false;
    const retiring: RuntimeOwnedProcessClaim = { ...record, state: "retiring" };
    const written = this.publishForSession(
      capability,
      temporaryClaimName(ownershipId, "retire"),
      canonical,
      stored(retiring),
    );
    return written;
  }

  records(runtimeGenerationId: string): RuntimeOwnedProcessRecord[] | null {
    try {
      const entry = this.sessions.all().find(({ session }) =>
        session.runtimeGenerationId === runtimeGenerationId);
      if (!entry || !settleSessionWriter(entry)) return null;
      const parsedSession = entry.session;
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

  inspectGeneration(
    runtimeGenerationId: string,
  ): RuntimeOwnedProcessGenerationInspection | null {
    if (!validRuntimeGenerationId(runtimeGenerationId)) return null;
    try {
      const sessionEntry = this.sessions.all().find(({ session }) => (
        session.runtimeGenerationId === runtimeGenerationId
      )) ?? null;
      if (sessionEntry && !settleSessionWriter(sessionEntry)) return null;
      const session = sessionEntry?.session ?? null;
      const containmentCanonical = containmentName(runtimeGenerationId);
      const containmentTemporary = `${containmentCanonical}.publish.tmp`;
      if (readDirectRuntimeJournalLeaf(
        this.root,
        containmentTemporary,
        MAX_RECORD_BYTES,
      )) return null;
      const containmentLeaf = readDirectRuntimeJournalLeaf(
        this.root,
        containmentCanonical,
        MAX_RECORD_BYTES,
      );
      if (containmentLeaf && !session) return null;
      const containment = containmentLeaf && session
        ? parseContainment(
            containmentLeaf.bytes,
            runtimeGenerationId,
            session.systemBootId,
          )
        : null;
      if (containmentLeaf && !containment) return null;

      const names = listDirectRuntimeJournalLeaves(
        this.root,
        CLAIM_PREFIX,
        MAX_CLAIMS * 4,
      );
      const records: RuntimeOwnedProcessRecord[] = [];
      const consumingRecords: RuntimeOwnedProcessRecord[] = [];
      for (const name of names) {
        const match = name.match(
          /^\.runtime-owned-child-([0-9a-f-]{36})\.(?:(json)|(begin|claim|retire|consume)\.tmp)$/iu,
        );
        if (!match || !UUID_PATTERN.test(match[1]!)) return null;
        const leaf = readDirectRuntimeJournalLeaf(
          this.root,
          name,
          MAX_RECORD_BYTES,
        );
        const record = leaf && parseRecord(leaf.bytes);
        if (!record || record.ownershipId !== match[1]) return null;
        if (match[3]) {
          if (record.runtimeGenerationId !== runtimeGenerationId) continue;
          if (match[3] === "consume") {
            consumingRecords.push(record);
            continue;
          }
          return null;
        }
        if (record.runtimeGenerationId === runtimeGenerationId) {
          records.push(record);
        }
      }
      return {
        session,
        sessionState: sessionEntry?.state ?? null,
        sessionWriterPresent: sessionEntry?.writerRoot !== null,
        records,
        consumingRecords,
        containment,
      };
    } catch {
      return null;
    }
  }

  finishSession(runtimeGenerationId: string,
    commitBeforeSessionRemoval: () => boolean = () => true,
  ): boolean {
    if (!supportedRuntimeOwnedProcessPlatform(this.platform)) {
      try { return commitBeforeSessionRemoval(); } catch { return false; }
    }
    const entry = (() => {
      try {
        return this.sessions.all().find(({ session }) =>
          session.runtimeGenerationId === runtimeGenerationId) ?? null;
      } catch {
        return null;
      }
    })();
    if (!entry) return false;
    const records = this.records(runtimeGenerationId);
    if (!records || records.length > 0) return false;
    const containment = containmentName(runtimeGenerationId);
    if (!removeLeaf(this.root, containment)) return false;
    return this.finishSessionExact(entry.session, commitBeforeSessionRemoval);
  }

  finishSessionExact(expected: RuntimeOwnedProcessSession,
    commitBeforeSessionRemoval: () => boolean = () => true,
  ): boolean {
    if (!supportedRuntimeOwnedProcessPlatform(this.platform)) {
      try { return commitBeforeSessionRemoval(); } catch { return false; }
    }
    let inspection = this.inspectGeneration(expected.runtimeGenerationId);
    if (
      !inspection
      || !inspection.session
      || JSON.stringify(inspection.session) !== JSON.stringify(expected)
      || inspection.sessionState === null
      || inspection.records.length > 0
      || inspection.consumingRecords.length > 0
      || inspection.containment !== null
    ) return false;
    const retiredSession = readDirectRuntimeJournalLeaf(
      this.root,
      runtimeOwnedProcessRetiringSessionName(expected.runtimeGenerationId),
      MAX_RECORD_BYTES,
    );
    if (inspection.sessionState === "active" || !retiredSession) {
      if (!this.fenceSessionExact(expected)) return false;
      inspection = this.inspectGeneration(expected.runtimeGenerationId);
      if (
        !inspection
        || inspection.sessionState !== "retiring"
        || !inspection.session
        || JSON.stringify(inspection.session) !== JSON.stringify(expected)
        || inspection.records.length > 0
        || inspection.consumingRecords.length > 0
        || inspection.containment !== null
      ) return false;
    }
    const canonical = runtimeOwnedProcessRetiringSessionName(
      expected.runtimeGenerationId,
    );
    const current = this.sessions.retiredLeaf(expected);
    if (!current) return false;
    const retiredWriterName = runtimeOwnedProcessRetiringWriterName(
      expected.runtimeGenerationId,
    );
    const retiredWriter = pinDirectRuntimeJournalChildRoot(
      this.root,
      retiredWriterName,
    );
    if (
      retiredWriter
      && !removeDirectRuntimeJournalChildRoot(
        this.root,
        retiredWriterName,
        retiredWriter,
      )
    ) return false;
    if (pinDirectRuntimeJournalChildRoot(
      this.root,
      runtimeOwnedProcessWriterName(expected.runtimeGenerationId),
    )) return false;
    try {
      if (!commitBeforeSessionRemoval()) return false;
    } catch {
      return false;
    }
    return unlinkDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      current.identity,
    );
  }

  clearPriorBootSessions(systemBootId: string): boolean {
    if (!supportedRuntimeOwnedProcessPlatform(this.platform)) return true;
    if (!validSystemBootId(systemBootId)) return false;
    if (systemBootId === "unavailable") return true;
    let sessions: RuntimeOwnedProcessSession[];
    try { sessions = this.sessions.all().map(({ session }) => session); } catch { return false; }
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
    try { sessions = this.sessions.all().map(({ session }) => session); } catch { return false; }
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
