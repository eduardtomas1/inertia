import { createHash, randomUUID } from "node:crypto";

import {
  directRuntimeJournalRootIsPinned,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
} from "../node/direct-runtime-journal.js";
import type { LinuxProcessIdentity } from
  "../node/runtime-owned-process-journal.js";
import type { AppUpdateHandoffSnapshot } from "./app-update-handoff.js";

const CLAIM_NAME = ".app-update-candidate-instance.json";
const CLAIM_PREFIX = ".app-update-candidate-instance";
const TERMINAL_PROOF_NAME = ".app-update-candidate-instance-terminal.json";
const MAX_CLAIM_BYTES = 2 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

export interface LinuxAppUpdateCandidateInstanceClaim {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly handoffChecksum: string;
  readonly launchId: string;
  readonly candidateArtifactDigest: string;
  readonly candidateExecutableIdentityDigest: string;
  readonly guardian: Required<LinuxProcessIdentity>;
  readonly payload: LinuxProcessIdentity;
  readonly checksum: string;
}

interface ClaimRecord {
  readonly leaf: DirectRuntimeJournalLeaf;
  readonly claim: LinuxAppUpdateCandidateInstanceClaim;
}

interface TerminalProofRecord {
  readonly leaf: DirectRuntimeJournalLeaf;
  readonly claim: LinuxAppUpdateCandidateInstanceClaim;
  readonly checksum: string;
}

const CLAIM_KEYS = [
  "candidateArtifactDigest",
  "candidateExecutableIdentityDigest",
  "checksum",
  "guardian",
  "handoffChecksum",
  "launchId",
  "operationId",
  "payload",
  "schemaVersion",
] as const;

const GUARDIAN_KEYS = [
  "guardianExecutableDevice",
  "guardianExecutableInode",
  "parentPid",
  "pid",
  "processGroupId",
  "startTimeTicks",
] as const;

const PROCESS_KEYS = [
  "parentPid",
  "pid",
  "processGroupId",
  "startTimeTicks",
] as const;

const TERMINAL_PROOF_KEYS = [
  "checksum",
  "claim",
  "schemaVersion",
  "state",
] as const;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validPid(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value) && Number(value) >= (allowZero ? 0 : 2);
}

function validProcessIdentity(
  value: unknown,
  guardian: boolean,
): value is Required<LinuxProcessIdentity> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!exactKeys(value, guardian ? GUARDIAN_KEYS : PROCESS_KEYS)) return false;
  const identity = value as Partial<Required<LinuxProcessIdentity>>;
  return validPid(identity.pid)
    && validPid(identity.parentPid, true)
    && validPid(identity.processGroupId)
    && typeof identity.startTimeTicks === "string"
    && INTEGER_PATTERN.test(identity.startTimeTicks)
    && identity.startTimeTicks !== "0"
    && (!guardian || (
      typeof identity.guardianExecutableDevice === "string"
      && INTEGER_PATTERN.test(identity.guardianExecutableDevice)
      && identity.guardianExecutableDevice !== "0"
      && typeof identity.guardianExecutableInode === "string"
      && INTEGER_PATTERN.test(identity.guardianExecutableInode)
      && identity.guardianExecutableInode !== "0"
    ));
}

function payload(
  claim: Omit<LinuxAppUpdateCandidateInstanceClaim, "checksum">,
): Omit<LinuxAppUpdateCandidateInstanceClaim, "checksum"> {
  return {
    schemaVersion: 1,
    operationId: claim.operationId,
    handoffChecksum: claim.handoffChecksum,
    launchId: claim.launchId,
    candidateArtifactDigest: claim.candidateArtifactDigest,
    candidateExecutableIdentityDigest:
      claim.candidateExecutableIdentityDigest,
    guardian: { ...claim.guardian },
    payload: { ...claim.payload },
  };
}

function checksum(
  claim: Omit<LinuxAppUpdateCandidateInstanceClaim, "checksum">,
): string {
  return createHash("sha256")
    .update("inertia.linux-app-update-candidate-instance.v1\0", "utf8")
    .update(JSON.stringify(payload(claim)), "utf8")
    .digest("hex");
}

function serialize(claim: LinuxAppUpdateCandidateInstanceClaim): Buffer {
  return Buffer.from(JSON.stringify({
    ...payload(claim),
    checksum: claim.checksum,
  }), "utf8");
}

function parse(bytes: Buffer): LinuxAppUpdateCandidateInstanceClaim | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const claim = value as Partial<LinuxAppUpdateCandidateInstanceClaim>;
    if (
      !exactKeys(value, CLAIM_KEYS)
      || claim.schemaVersion !== 1
      || typeof claim.operationId !== "string"
      || !UUID_PATTERN.test(claim.operationId)
      || typeof claim.handoffChecksum !== "string"
      || !DIGEST_PATTERN.test(claim.handoffChecksum)
      || typeof claim.launchId !== "string"
      || !UUID_PATTERN.test(claim.launchId)
      || typeof claim.candidateArtifactDigest !== "string"
      || !DIGEST_PATTERN.test(claim.candidateArtifactDigest)
      || typeof claim.candidateExecutableIdentityDigest !== "string"
      || !DIGEST_PATTERN.test(claim.candidateExecutableIdentityDigest)
      || !validProcessIdentity(claim.guardian, true)
      || !validProcessIdentity(claim.payload, false)
      || typeof claim.checksum !== "string"
      || !DIGEST_PATTERN.test(claim.checksum)
    ) return null;
    const exact = claim as LinuxAppUpdateCandidateInstanceClaim;
    return checksum(exact) === exact.checksum
      ? Object.freeze(exact)
      : null;
  } catch {
    return null;
  }
}

function equal(
  left: LinuxAppUpdateCandidateInstanceClaim,
  right: LinuxAppUpdateCandidateInstanceClaim,
): boolean {
  return left.checksum === right.checksum
    && serialize(left).equals(serialize(right));
}

function terminalProofChecksum(
  claim: LinuxAppUpdateCandidateInstanceClaim,
): string {
  return createHash("sha256")
    .update("inertia.linux-app-update-candidate-terminal-proof.v1\0", "utf8")
    .update(serialize(claim))
    .digest("hex");
}

function serializeTerminalProof(
  claim: LinuxAppUpdateCandidateInstanceClaim,
): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    state: "terminal-proved",
    claim,
    checksum: terminalProofChecksum(claim),
  }), "utf8");
}

function parseTerminalProof(bytes: Buffer): {
  readonly claim: LinuxAppUpdateCandidateInstanceClaim;
  readonly checksum: string;
} | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as {
      readonly schemaVersion?: unknown;
      readonly state?: unknown;
      readonly claim?: unknown;
      readonly checksum?: unknown;
    };
    if (
      !exactKeys(value, TERMINAL_PROOF_KEYS)
      || candidate.schemaVersion !== 1
      || candidate.state !== "terminal-proved"
      || typeof candidate.checksum !== "string"
      || !DIGEST_PATTERN.test(candidate.checksum)
    ) return null;
    const claim = parse(Buffer.from(JSON.stringify(candidate.claim), "utf8"));
    if (!claim || terminalProofChecksum(claim) !== candidate.checksum) return null;
    return Object.freeze({ claim, checksum: candidate.checksum });
  } catch {
    return null;
  }
}

export function createLinuxAppUpdateCandidateLaunchId(): string {
  return randomUUID();
}

export class LinuxAppUpdateCandidateClaimJournal {
  private readonly root: DirectRuntimeJournalRoot;

  constructor(dataDirectory: string) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
  }

  private names(): string[] {
    if (!directRuntimeJournalRootIsPinned(this.root)) {
      throw new Error("The app update candidate claim root identity changed.");
    }
    const names = listDirectRuntimeJournalLeaves(
      this.root,
      CLAIM_PREFIX,
      3,
    );
    if (names.some((name) =>
      name !== CLAIM_NAME && name !== TERMINAL_PROOF_NAME)) {
      throw new Error("The app update candidate claim contains a foreign entry.");
    }
    return names;
  }

  private record(): ClaimRecord | null {
    this.names();
    const leaf = readDirectRuntimeJournalLeaf(
      this.root,
      CLAIM_NAME,
      MAX_CLAIM_BYTES,
    );
    if (!leaf) return null;
    const claim = parse(leaf.bytes);
    if (!claim) throw new Error("The app update candidate claim is invalid.");
    return { leaf, claim };
  }

  private terminalRecord(): TerminalProofRecord | null {
    this.names();
    const leaf = readDirectRuntimeJournalLeaf(
      this.root,
      TERMINAL_PROOF_NAME,
      MAX_CLAIM_BYTES * 2,
    );
    if (!leaf) return null;
    const proof = parseTerminalProof(leaf.bytes);
    if (!proof) {
      throw new Error("The app update candidate terminal proof is invalid.");
    }
    return { leaf, ...proof };
  }

  private requireSnapshotMatch(
    claim: LinuxAppUpdateCandidateInstanceClaim,
    snapshot: AppUpdateHandoffSnapshot,
  ): void {
    if (
      snapshot.platform !== "linux"
      || claim.operationId !== snapshot.operationId
      || claim.candidateArtifactDigest !== snapshot.candidateArtifactDigest
      || claim.candidateExecutableIdentityDigest
        !== snapshot.candidateExecutableIdentityDigest
      || (snapshot.phase === "candidate-launched"
        && claim.handoffChecksum !== snapshot.checksum)
    ) throw new Error("The app update candidate claim has stale authority.");
  }

  current(snapshot: AppUpdateHandoffSnapshot):
    LinuxAppUpdateCandidateInstanceClaim | null {
    const current = this.record()?.claim ?? null;
    if (!current) return null;
    this.requireSnapshotMatch(current, snapshot);
    return current;
  }

  recovery(snapshot: AppUpdateHandoffSnapshot): {
    readonly claim: LinuxAppUpdateCandidateInstanceClaim;
    readonly terminalProved: boolean;
  } | null {
    const active = this.record()?.claim ?? null;
    const proof = this.terminalRecord()?.claim ?? null;
    if (active && proof && !equal(active, proof)) {
      throw new Error("The app update candidate recovery proofs conflict.");
    }
    const claim = active ?? proof;
    if (!claim) return null;
    this.requireSnapshotMatch(claim, snapshot);
    return Object.freeze({ claim, terminalProved: proof !== null });
  }

  claim(
    snapshot: AppUpdateHandoffSnapshot,
    launchId: string,
    guardian: Required<LinuxProcessIdentity>,
    candidatePayload: LinuxProcessIdentity,
  ): LinuxAppUpdateCandidateInstanceClaim | null {
    if (
      snapshot.platform !== "linux"
      || snapshot.phase !== "candidate-launched"
      || !UUID_PATTERN.test(launchId)
      || !validProcessIdentity(guardian, true)
      || !validProcessIdentity(candidatePayload, false)
      || guardian.pid !== guardian.processGroupId
      || candidatePayload.parentPid !== guardian.pid
      || candidatePayload.processGroupId !== guardian.pid
    ) return null;
    const unsigned = payload({
      schemaVersion: 1,
      operationId: snapshot.operationId,
      handoffChecksum: snapshot.checksum,
      launchId,
      candidateArtifactDigest: snapshot.candidateArtifactDigest,
      candidateExecutableIdentityDigest:
        snapshot.candidateExecutableIdentityDigest,
      guardian,
      payload: candidatePayload,
    });
    const proposed = Object.freeze({
      ...unsigned,
      checksum: checksum(unsigned),
    });
    if (this.terminalRecord()) return null;
    const existing = this.current(snapshot);
    if (existing) return equal(existing, proposed) ? existing : null;
    // Using the same direct leaf as both source and destination makes the
    // O_EXCL creation itself the singleton commit; no replace-capable rename
    // is involved when two candidates race.
    if (!writeDirectRuntimeJournalLeaf(
      this.root,
      CLAIM_NAME,
      CLAIM_NAME,
      serialize(proposed),
    )) return null;
    const committed = this.current(snapshot);
    return committed && equal(committed, proposed) ? committed : null;
  }

  terminalProved(
    expected: LinuxAppUpdateCandidateInstanceClaim,
  ): boolean {
    const proof = this.terminalRecord();
    return !!proof && equal(proof.claim, expected);
  }

  publishTerminalProof(
    expected: LinuxAppUpdateCandidateInstanceClaim,
  ): boolean {
    const current = this.record();
    if (!current || !equal(current.claim, expected)) return false;
    const existing = this.terminalRecord();
    if (existing) return equal(existing.claim, expected);
    if (!writeDirectRuntimeJournalLeaf(
      this.root,
      TERMINAL_PROOF_NAME,
      TERMINAL_PROOF_NAME,
      serializeTerminalProof(expected),
    )) return false;
    const committed = this.terminalRecord();
    return !!committed && equal(committed.claim, expected);
  }

  retire(expected: LinuxAppUpdateCandidateInstanceClaim): boolean {
    const current = this.record();
    const proof = this.terminalRecord();
    if (
      (current && !equal(current.claim, expected))
      || (proof && !equal(proof.claim, expected))
    ) return false;
    if (current && !unlinkDirectRuntimeJournalLeaf(
      this.root,
      CLAIM_NAME,
      current.leaf.identity,
    )) return false;
    const remainingProof = this.terminalRecord();
    if (remainingProof && !unlinkDirectRuntimeJournalLeaf(
      this.root,
      TERMINAL_PROOF_NAME,
      remainingProof.leaf.identity,
    )) return false;
    return this.record() === null && this.terminalRecord() === null;
  }
}
