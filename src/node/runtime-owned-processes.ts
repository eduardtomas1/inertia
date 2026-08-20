import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

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

const CLAIM_PREFIX = ".runtime-owned-child-";
const SESSION_PREFIX = ".runtime-owned-process-session-";
const MAX_CLAIMS = 256;
const MAX_SESSIONS = 32;
const MAX_RECORD_BYTES = 768;
const SCHEMA_VERSION = 1;
const PROCESS_GROUP_EXIT_WAIT_MS = 1_000;
const PROCESS_GROUP_EXIT_POLL_MS = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LinuxProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startTimeTicks: string;
}

interface RuntimeOwnedProcessSession {
  readonly version: typeof SCHEMA_VERSION;
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
}

interface RuntimeOwnedProcessPending extends RuntimeOwnedProcessSession {
  readonly state: "pending";
  readonly ownershipId: string;
}

export interface RuntimeOwnedProcessClaim extends RuntimeOwnedProcessSession {
  readonly state: "owned";
  readonly ownershipId: string;
  readonly process: LinuxProcessIdentity;
}

type RuntimeOwnedProcessRecord = RuntimeOwnedProcessPending | RuntimeOwnedProcessClaim;

function generationHash(runtimeGenerationId: string): string {
  return createHash("sha256").update(runtimeGenerationId).digest("hex");
}

function sessionName(runtimeGenerationId: string): string {
  return `${SESSION_PREFIX}${generationHash(runtimeGenerationId)}.json`;
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

function validTicks(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,30}$/u.test(value);
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
      return exactKeys(value, [
        "ownershipId",
        "runtimeGenerationId",
        "state",
        "systemBootId",
        "version",
      ]) ? record as RuntimeOwnedProcessPending : null;
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
      || !exactKeys(record.process, [
        "parentPid",
        "pid",
        "processGroupId",
        "startTimeTicks",
      ])
      || !validPid(record.process.pid)
      || !validPid(record.process.parentPid)
      || !validPid(record.process.processGroupId)
      || !validTicks(record.process.startTimeTicks)
    ) return null;
    return record as RuntimeOwnedProcessClaim;
  } catch {
    return null;
  }
}

export function readLinuxProcessIdentity(
  pid: number,
  readFile: typeof readFileSync = readFileSync,
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
    || !validPid(parentPid)
    || !validPid(processGroupId)
    || !validTicks(startTimeTicks)
  ) throw new Error("The owned process identity is invalid.");
  return { pid, parentPid, processGroupId, startTimeTicks };
}

function sameProcess(
  left: LinuxProcessIdentity,
  right: LinuxProcessIdentity,
): boolean {
  return left.pid === right.pid
    && left.processGroupId === right.processGroupId
    && left.startTimeTicks === right.startTimeTicks;
}

function stored(value: RuntimeOwnedProcessSession | RuntimeOwnedProcessRecord): Buffer {
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

  constructor(dataDirectory: string) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
  }

  startSession(runtimeGenerationId: string, systemBootId: string): boolean {
    if (process.platform !== "linux") return true;
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
    const pending: RuntimeOwnedProcessPending = {
      version: SCHEMA_VERSION,
      state: "pending",
      ownershipId,
      runtimeGenerationId,
      systemBootId,
    };
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
    const identity = readLinuxProcessIdentity(pid);
    if (
      pending?.state !== "pending"
      || pending.runtimeGenerationId !== runtimeGenerationId
      || pending.systemBootId !== systemBootId
      || !identity
      || identity.parentPid !== expectedParentPid
      || identity.processGroupId !== pid
    ) throw new Error("The spawned process ownership could not be proven.");
    const claim: RuntimeOwnedProcessClaim = {
      ...pending,
      state: "owned",
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
    if (process.platform !== "linux") return true;
    const records = this.records(runtimeGenerationId);
    if (!records || records.length > 0) return false;
    return removeLeaf(this.root, sessionName(runtimeGenerationId));
  }

  static identityMatches(
    claim: RuntimeOwnedProcessClaim,
    identity: LinuxProcessIdentity,
  ): boolean {
    return sameProcess(claim.process, identity);
  }
}

interface ActiveRuntimeOwnedProcessRegistry {
  readonly journal: RuntimeOwnedProcessJournal;
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
  readonly claims: WeakMap<ChildProcess, ActiveRuntimeOwnedProcessClaim>;
}

interface ActiveRuntimeOwnedProcessClaim {
  readonly ownershipId: string;
  released: boolean;
}

let activeRegistry: ActiveRuntimeOwnedProcessRegistry | null = null;

export function activateRuntimeOwnedProcessRegistry(
  dataDirectory: string,
  runtimeGenerationId: string,
  systemBootId: string,
): (() => void) | null {
  if (process.platform !== "linux") return null;
  if (activeRegistry) {
    throw new Error("The runtime process ownership registry is already active.");
  }
  const journal = new RuntimeOwnedProcessJournal(dataDirectory);
  if (!journal.startSession(runtimeGenerationId, systemBootId)) {
    throw new Error("The runtime process ownership session could not be persisted.");
  }
  const registry: ActiveRuntimeOwnedProcessRegistry = {
    journal,
    runtimeGenerationId,
    systemBootId,
    claims: new WeakMap(),
  };
  activeRegistry = registry;
  return () => {
    if (activeRegistry === registry) activeRegistry = null;
  };
}

function hardStopUnclaimed(child: Pick<ChildProcess, "pid" | "kill">): void {
  const pid = child.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* The group may be gone. */ }
  try { child.kill("SIGKILL"); } catch { /* The child may be gone. */ }
}

function releaseIfGroupExited(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
): void {
  const deadlineAt = Date.now() + PROCESS_GROUP_EXIT_WAIT_MS;
  const poll = (): void => {
    if (activeRegistry !== registry || claim.released) return;
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "code" in error
        && error.code === "ESRCH"
      ) {
        try { releaseActiveClaim(registry, claim); } catch {
          // A removed test/runtime root cannot authorize further mutation.
        }
        return;
      }
    }
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) return;
    const timer = setTimeout(
      poll,
      Math.max(1, Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs)),
    );
    timer.unref();
  };
  const timer = setTimeout(poll, 0);
  timer.unref();
}

function releaseActiveClaim(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
): boolean {
  if (claim.released) return true;
  if (!registry.journal.release(claim.ownershipId)) return false;
  claim.released = true;
  return true;
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
  let child: T;
  try {
    child = spawnProcess();
  } catch (error) {
    registry.journal.release(ownershipId);
    throw error;
  }
  try {
    registry.journal.claim(
      ownershipId,
      registry.runtimeGenerationId,
      registry.systemBootId,
      child.pid ?? 0,
      process.pid,
    );
    const claim = { ownershipId, released: false };
    registry.claims.set(child, claim);
    child.once("close", () => {
      releaseIfGroupExited(registry, claim, child.pid ?? 0);
    });
  } catch (error) {
    hardStopUnclaimed(child);
    throw error;
  }
  return child;
}

export interface RuntimeOwnedPidProcess<T> {
  readonly process: T;
  confirmStopped(): boolean;
  releaseIfGroupExited(): void;
}

export function spawnRuntimeOwnedPidProcess<T extends { readonly pid: number }>(
  spawnProcess: () => T,
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
  let owned: T | null = null;
  try {
    owned = spawnProcess();
    registry.journal.claim(
      ownershipId,
      registry.runtimeGenerationId,
      registry.systemBootId,
      owned.pid,
      process.pid,
    );
  } catch (error) {
    if (owned) {
      const failedOwned = owned;
      hardStopUnclaimed({
        pid: failedOwned.pid,
        kill: () => {
          try { process.kill(failedOwned.pid, "SIGKILL"); } catch { /* Gone. */ }
          return true;
        },
      });
    } else registry.journal.release(ownershipId);
    throw error;
  }
  const confirmedOwned = owned;
  const claim = { ownershipId, released: false };
  return {
    process: confirmedOwned,
    confirmStopped: () => releaseActiveClaim(registry, claim),
    releaseIfGroupExited: () =>
      releaseIfGroupExited(registry, claim, confirmedOwned.pid),
  };
}

export function confirmRuntimeOwnedProcessStopped(child: ChildProcess): boolean {
  const registry = activeRegistry;
  const claim = registry?.claims.get(child);
  return registry && claim ? releaseActiveClaim(registry, claim) : true;
}

export function runtimeOwnedProcessCleanupConfirmed(): boolean {
  if (!activeRegistry) return process.platform !== "linux";
  const records = activeRegistry.journal.records(
    activeRegistry.runtimeGenerationId,
  );
  return records !== null && records.length === 0;
}
