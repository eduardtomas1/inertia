import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  discardDirectRuntimeJournalLeaf,
  directRuntimeJournalRootIsPinned,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  renameDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
  type DirectRuntimeJournalTestHooks,
} from "../node/direct-runtime-journal.js";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "../node/runtime-process-protocol.js";

const HANDOFF_SCHEMA_VERSION = 1;
const HANDOFF_PREFIX = ".app-update-handoff";
const HANDOFF_CANONICAL = `${HANDOFF_PREFIX}.json`;
const HANDOFF_CONSUME = `${HANDOFF_PREFIX}.consume.tmp`;
const MAX_HANDOFF_BYTES = 4 * 1_024;
const MAX_HANDOFF_LEAVES = 16;
const MAX_HANDOFF_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_HANDOFF_REVISIONS = 8;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export type AppUpdateHandoffPlatform = "linux" | "win32";
export type AppUpdateHandoffChannel = "canary" | "stable";
export type AppUpdateHandoffPhase =
  | "prepared"
  | "candidate-launched"
  | "candidate-bootstrap-validated"
  | "old-generation-cleanup-confirmed"
  | "ownership-transfer-committed"
  | "candidate-admitted"
  | "completed"
  | "rollback-required"
  | "rollback-completed";

export interface AppUpdateHandoffPreparation {
  readonly operationId: string;
  readonly platform: AppUpdateHandoffPlatform;
  readonly channel: AppUpdateHandoffChannel;
  readonly oldVersion: string;
  readonly newVersion: string;
  readonly oldRuntimeGenerationId: string;
  readonly systemBootId: string;
  readonly candidateArtifactDigest: string;
  readonly candidateExecutableIdentityDigest: string;
  readonly profileIdentityDigest: string;
  readonly dataIdentityDigest: string;
  readonly handoffTokenDigest: string;
  readonly createdAt: string;
  readonly deadlineAt: string;
}

export interface AppUpdateHandoffSnapshot
  extends AppUpdateHandoffPreparation {
  readonly schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  readonly phase: AppUpdateHandoffPhase;
  readonly revision: number;
  readonly transitionedAt: string;
  readonly previousChecksum: string | null;
  readonly checksum: string;
}

export interface AppUpdateHandoffOwner {
  readonly operationId: string;
  readonly revision: number;
  readonly checksum: string;
}

export interface AppUpdateCandidateBootstrapAcknowledgement {
  readonly operationId: string;
  readonly platform: AppUpdateHandoffPlatform;
  readonly channel: AppUpdateHandoffChannel;
  readonly oldVersion: string;
  readonly newVersion: string;
  readonly oldRuntimeGenerationId: string;
  readonly candidateArtifactDigest: string;
  readonly candidateExecutableIdentityDigest: string;
  readonly profileIdentityDigest: string;
  readonly dataIdentityDigest: string;
  readonly handoffToken: string;
}

export type AppUpdateHandoffDiagnostic =
  | { readonly state: "none" }
  | {
    readonly state: "active" | "rollback" | "terminal";
    readonly phase: AppUpdateHandoffPhase;
    readonly platform: AppUpdateHandoffPlatform;
    readonly channel: AppUpdateHandoffChannel;
    readonly oldVersion: string;
    readonly newVersion: string;
    readonly operationTag: string;
    readonly oldRuntimeGenerationTag: string;
    readonly revision: number;
    readonly createdAt: string;
    readonly deadlineAt: string;
    readonly transitionedAt: string;
    readonly expired: boolean;
  };

export interface AppUpdateHandoffJournalOptions {
  readonly clock?: () => Date;
  readonly testHooks?: DirectRuntimeJournalTestHooks;
}

export interface AppUpdateHandoffTokenReceipt {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly handoffToken: string;
  readonly createdAt: string;
  readonly deadlineAt: string;
  readonly checksum: string;
}

interface ParsedSemver {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[] | null;
}

const SNAPSHOT_KEYS = [
  "candidateArtifactDigest",
  "candidateExecutableIdentityDigest",
  "channel",
  "checksum",
  "createdAt",
  "dataIdentityDigest",
  "deadlineAt",
  "handoffTokenDigest",
  "newVersion",
  "oldRuntimeGenerationId",
  "oldVersion",
  "operationId",
  "phase",
  "platform",
  "previousChecksum",
  "profileIdentityDigest",
  "revision",
  "schemaVersion",
  "systemBootId",
  "transitionedAt",
] as const;

const PREPARATION_KEYS = [
  "candidateArtifactDigest",
  "candidateExecutableIdentityDigest",
  "channel",
  "createdAt",
  "dataIdentityDigest",
  "deadlineAt",
  "handoffTokenDigest",
  "newVersion",
  "oldRuntimeGenerationId",
  "oldVersion",
  "operationId",
  "platform",
  "profileIdentityDigest",
  "systemBootId",
] as const;

const IMMUTABLE_KEYS = [
  "operationId",
  "platform",
  "channel",
  "oldVersion",
  "newVersion",
  "oldRuntimeGenerationId",
  "systemBootId",
  "candidateArtifactDigest",
  "candidateExecutableIdentityDigest",
  "profileIdentityDigest",
  "dataIdentityDigest",
  "handoffTokenDigest",
  "createdAt",
  "deadlineAt",
] as const satisfies readonly (keyof AppUpdateHandoffPreparation)[];

const CANDIDATE_ACKNOWLEDGEMENT_KEYS = [
  "candidateArtifactDigest",
  "candidateExecutableIdentityDigest",
  "channel",
  "dataIdentityDigest",
  "handoffToken",
  "newVersion",
  "oldRuntimeGenerationId",
  "oldVersion",
  "operationId",
  "platform",
  "profileIdentityDigest",
] as const;

const TOKEN_RECEIPT_KEYS = [
  "checksum",
  "createdAt",
  "deadlineAt",
  "handoffToken",
  "operationId",
  "schemaVersion",
] as const;

const LINUX_HAPPY_PATH: readonly AppUpdateHandoffPhase[] = [
  "prepared",
  "candidate-launched",
  "candidate-bootstrap-validated",
  "old-generation-cleanup-confirmed",
  "ownership-transfer-committed",
  "candidate-admitted",
  "completed",
];

const WINDOWS_HAPPY_PATH: readonly AppUpdateHandoffPhase[] = [
  "prepared",
  "old-generation-cleanup-confirmed",
  "ownership-transfer-committed",
  "candidate-launched",
  "candidate-bootstrap-validated",
  "candidate-admitted",
  "completed",
];

function happyPath(
  platform: AppUpdateHandoffPlatform,
): readonly AppUpdateHandoffPhase[] {
  return platform === "linux" ? LINUX_HAPPY_PATH : WINDOWS_HAPPY_PATH;
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function parseSemver(value: unknown): ParsedSemver | null {
  if (typeof value !== "string" || value.length > 96) return null;
  const match = value.match(SEMVER_PATTERN);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  return {
    core,
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function compareSemver(leftValue: string, rightValue: string): number {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) return Number.NaN;
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validPhase(value: unknown): value is AppUpdateHandoffPhase {
  return value === "prepared"
    || value === "candidate-launched"
    || value === "candidate-bootstrap-validated"
    || value === "old-generation-cleanup-confirmed"
    || value === "ownership-transfer-committed"
    || value === "candidate-admitted"
    || value === "completed"
    || value === "rollback-required"
    || value === "rollback-completed";
}

function terminalPhase(phase: AppUpdateHandoffPhase): boolean {
  return phase === "completed" || phase === "rollback-completed";
}

function rollbackPhase(phase: AppUpdateHandoffPhase): boolean {
  return phase === "rollback-required" || phase === "rollback-completed";
}

function validPhaseRevision(
  platform: AppUpdateHandoffPlatform,
  phase: AppUpdateHandoffPhase,
  revision: number,
): boolean {
  const happyRevision = happyPath(platform).indexOf(phase) + 1;
  if (happyRevision > 0) return revision === happyRevision;
  if (phase === "rollback-required") {
    return revision >= 2 && revision <= MAX_HANDOFF_REVISIONS - 1;
  }
  return phase === "rollback-completed"
    && revision >= 3
    && revision <= MAX_HANDOFF_REVISIONS;
}

export function appUpdateHandoffCanTransition(
  platform: AppUpdateHandoffPlatform,
  current: AppUpdateHandoffPhase,
  next: AppUpdateHandoffPhase,
): boolean {
  if (terminalPhase(current) || current === next) return false;
  if (next === "rollback-required") return current !== "rollback-required";
  if (current === "rollback-required") return next === "rollback-completed";
  if (rollbackPhase(next)) return false;
  const path = happyPath(platform);
  const currentIndex = path.indexOf(current);
  return currentIndex >= 0 && path[currentIndex + 1] === next;
}

function preparationFrom(
  value: Pick<AppUpdateHandoffSnapshot, keyof AppUpdateHandoffPreparation>,
): AppUpdateHandoffPreparation {
  return {
    operationId: value.operationId,
    platform: value.platform,
    channel: value.channel,
    oldVersion: value.oldVersion,
    newVersion: value.newVersion,
    oldRuntimeGenerationId: value.oldRuntimeGenerationId,
    systemBootId: value.systemBootId,
    candidateArtifactDigest: value.candidateArtifactDigest,
    candidateExecutableIdentityDigest: value.candidateExecutableIdentityDigest,
    profileIdentityDigest: value.profileIdentityDigest,
    dataIdentityDigest: value.dataIdentityDigest,
    handoffTokenDigest: value.handoffTokenDigest,
    createdAt: value.createdAt,
    deadlineAt: value.deadlineAt,
  };
}

function validPreparation(value: unknown): value is AppUpdateHandoffPreparation {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactObjectKeys(value, PREPARATION_KEYS)
  ) return false;
  const candidate = value as Partial<AppUpdateHandoffPreparation>;
  if (
    typeof candidate.operationId !== "string"
    || (candidate.platform !== "linux" && candidate.platform !== "win32")
    || (candidate.channel !== "canary" && candidate.channel !== "stable")
    || typeof candidate.oldVersion !== "string"
    || typeof candidate.newVersion !== "string"
    || typeof candidate.oldRuntimeGenerationId !== "string"
    || typeof candidate.systemBootId !== "string"
    || typeof candidate.candidateArtifactDigest !== "string"
    || typeof candidate.candidateExecutableIdentityDigest !== "string"
    || typeof candidate.profileIdentityDigest !== "string"
    || typeof candidate.dataIdentityDigest !== "string"
    || typeof candidate.handoffTokenDigest !== "string"
    || typeof candidate.createdAt !== "string"
    || typeof candidate.deadlineAt !== "string"
  ) return false;
  const preparation = candidate as AppUpdateHandoffPreparation;
  const createdAt = canonicalTimestamp(preparation.createdAt)
    ? Date.parse(preparation.createdAt)
    : Number.NaN;
  const deadlineAt = canonicalTimestamp(preparation.deadlineAt)
    ? Date.parse(preparation.deadlineAt)
    : Number.NaN;
  const validPlatformBoot = preparation.systemBootId.startsWith("test:")
    || (preparation.platform === "linux"
      && preparation.systemBootId.startsWith("linux:"))
    || (preparation.platform === "win32"
      && preparation.systemBootId.startsWith("win32:"));
  return UUID_PATTERN.test(preparation.operationId)
    && parseSemver(preparation.oldVersion) !== null
    && parseSemver(preparation.newVersion) !== null
    && compareSemver(preparation.newVersion, preparation.oldVersion) > 0
    && validRuntimeGenerationId(preparation.oldRuntimeGenerationId)
    && validSystemBootId(preparation.systemBootId)
    && preparation.systemBootId !== "unavailable"
    && validPlatformBoot
    && DIGEST_PATTERN.test(preparation.candidateArtifactDigest)
    && DIGEST_PATTERN.test(preparation.candidateExecutableIdentityDigest)
    && DIGEST_PATTERN.test(preparation.profileIdentityDigest)
    && DIGEST_PATTERN.test(preparation.dataIdentityDigest)
    && DIGEST_PATTERN.test(preparation.handoffTokenDigest)
    && Number.isFinite(createdAt)
    && Number.isFinite(deadlineAt)
    && deadlineAt > createdAt
    && deadlineAt - createdAt <= MAX_HANDOFF_LIFETIME_MS;
}

function snapshotPayload(
  snapshot: Omit<AppUpdateHandoffSnapshot, "checksum">,
): Omit<AppUpdateHandoffSnapshot, "checksum"> {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    ...preparationFrom(snapshot),
    phase: snapshot.phase,
    revision: snapshot.revision,
    transitionedAt: snapshot.transitionedAt,
    previousChecksum: snapshot.previousChecksum,
  };
}

function checksumFor(
  snapshot: Omit<AppUpdateHandoffSnapshot, "checksum">,
): string {
  return createHash("sha256")
    .update("inertia.app-update-handoff.snapshot.v1\0", "utf8")
    .update(JSON.stringify(snapshotPayload(snapshot)), "utf8")
    .digest("hex");
}

function createSnapshot(
  preparation: AppUpdateHandoffPreparation,
  phase: AppUpdateHandoffPhase,
  revision: number,
  transitionedAt: string,
  previousChecksum: string | null,
): AppUpdateHandoffSnapshot {
  const payload = snapshotPayload({
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    ...preparation,
    phase,
    revision,
    transitionedAt,
    previousChecksum,
  });
  return Object.freeze({
    ...payload,
    checksum: checksumFor(payload),
  });
}

function serializeSnapshot(snapshot: AppUpdateHandoffSnapshot): Buffer {
  return Buffer.from(JSON.stringify({
    ...snapshotPayload(snapshot),
    checksum: snapshot.checksum,
  }), "utf8");
}

function parseSnapshot(bytes: Buffer): AppUpdateHandoffSnapshot | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || !exactObjectKeys(value, SNAPSHOT_KEYS)
    ) return null;
    const candidate = value as Partial<AppUpdateHandoffSnapshot>;
    if (
      candidate.schemaVersion !== HANDOFF_SCHEMA_VERSION
      || typeof candidate.operationId !== "string"
      || (candidate.platform !== "linux" && candidate.platform !== "win32")
      || (candidate.channel !== "canary" && candidate.channel !== "stable")
      || typeof candidate.oldVersion !== "string"
      || typeof candidate.newVersion !== "string"
      || typeof candidate.oldRuntimeGenerationId !== "string"
      || typeof candidate.systemBootId !== "string"
      || typeof candidate.candidateArtifactDigest !== "string"
      || typeof candidate.candidateExecutableIdentityDigest !== "string"
      || typeof candidate.profileIdentityDigest !== "string"
      || typeof candidate.dataIdentityDigest !== "string"
      || typeof candidate.handoffTokenDigest !== "string"
      || typeof candidate.createdAt !== "string"
      || typeof candidate.deadlineAt !== "string"
      || !validPhase(candidate.phase)
      || !Number.isSafeInteger(candidate.revision)
      || candidate.revision! < 1
      || candidate.revision! > MAX_HANDOFF_REVISIONS
      || typeof candidate.transitionedAt !== "string"
      || (
        candidate.previousChecksum !== null
        && typeof candidate.previousChecksum !== "string"
      )
      || typeof candidate.checksum !== "string"
    ) return null;
    const snapshot = candidate as AppUpdateHandoffSnapshot;
    const preparation = preparationFrom(snapshot);
    const transitionedAt = canonicalTimestamp(snapshot.transitionedAt)
      ? Date.parse(snapshot.transitionedAt)
      : Number.NaN;
    if (
      !validPreparation(preparation)
      || !validPhaseRevision(snapshot.platform, snapshot.phase, snapshot.revision)
      || !Number.isFinite(transitionedAt)
      || transitionedAt < Date.parse(snapshot.createdAt)
      || (!rollbackPhase(snapshot.phase)
        && transitionedAt > Date.parse(snapshot.deadlineAt))
      || (snapshot.revision === 1) !== (snapshot.previousChecksum === null)
      || (snapshot.previousChecksum !== null
        && !DIGEST_PATTERN.test(snapshot.previousChecksum))
      || !DIGEST_PATTERN.test(snapshot.checksum)
      || checksumFor(snapshot) !== snapshot.checksum
    ) return null;
    return Object.freeze({ ...snapshot });
  } catch {
    return null;
  }
}

function immutableIdentityMatches(
  left: AppUpdateHandoffPreparation,
  right: AppUpdateHandoffPreparation,
): boolean {
  return IMMUTABLE_KEYS.every((key) => left[key] === right[key]);
}

function snapshotMatches(
  left: AppUpdateHandoffSnapshot,
  right: AppUpdateHandoffSnapshot,
): boolean {
  return left.checksum === right.checksum
    && serializeSnapshot(left).equals(serializeSnapshot(right));
}

function immediateSuccessor(
  current: AppUpdateHandoffSnapshot,
  proposal: AppUpdateHandoffSnapshot,
): boolean {
  return immutableIdentityMatches(current, proposal)
    && proposal.revision === current.revision + 1
    && proposal.previousChecksum === current.checksum
    && Date.parse(proposal.transitionedAt) >= Date.parse(current.transitionedAt)
    && appUpdateHandoffCanTransition(
      current.platform,
      current.phase,
      proposal.phase,
    );
}

function proposalNames(checksum: string): {
  readonly canonical: string;
  readonly temporary: string;
} {
  const stem = `${HANDOFF_PREFIX}-proposal-${checksum}`;
  return {
    canonical: `${stem}.json`,
    temporary: `${stem}.publish.tmp`,
  };
}

function proposalMatch(name: string): {
  readonly checksum: string;
  readonly temporary: boolean;
} | null {
  const match = name.match(
    /^\.app-update-handoff-proposal-([0-9a-f]{64})\.(json|publish\.tmp)$/u,
  );
  return match
    ? { checksum: match[1]!, temporary: match[2] === "publish.tmp" }
    : null;
}

function readSnapshotLeaf(
  root: DirectRuntimeJournalRoot,
  name: string,
  hooks?: DirectRuntimeJournalTestHooks,
): { readonly leaf: DirectRuntimeJournalLeaf; readonly snapshot: AppUpdateHandoffSnapshot } | null {
  const leaf = readDirectRuntimeJournalLeaf(
    root,
    name,
    MAX_HANDOFF_BYTES,
    hooks,
  );
  if (!leaf) return null;
  const snapshot = parseSnapshot(leaf.bytes);
  if (!snapshot) throw new Error("The app update handoff journal is invalid.");
  return { leaf, snapshot };
}

function ownerMatches(
  owner: AppUpdateHandoffOwner,
  snapshot: AppUpdateHandoffSnapshot,
): boolean {
  return owner.operationId === snapshot.operationId
    && owner.revision === snapshot.revision
    && owner.checksum === snapshot.checksum;
}

function validOwner(owner: unknown): owner is AppUpdateHandoffOwner {
  if (
    !owner
    || typeof owner !== "object"
    || Array.isArray(owner)
    || !exactObjectKeys(owner, ["checksum", "operationId", "revision"])
  ) return false;
  const candidate = owner as Partial<AppUpdateHandoffOwner>;
  return typeof candidate.operationId === "string"
    && typeof candidate.revision === "number"
    && typeof candidate.checksum === "string"
    && UUID_PATTERN.test(candidate.operationId)
    && Number.isSafeInteger(candidate.revision)
    && candidate.revision >= 1
    && candidate.revision <= MAX_HANDOFF_REVISIONS
    && DIGEST_PATTERN.test(candidate.checksum);
}

function validCandidateAcknowledgement(
  acknowledgement: unknown,
): acknowledgement is AppUpdateCandidateBootstrapAcknowledgement {
  if (
    !acknowledgement
    || typeof acknowledgement !== "object"
    || Array.isArray(acknowledgement)
    || !exactObjectKeys(acknowledgement, CANDIDATE_ACKNOWLEDGEMENT_KEYS)
  ) return false;
  const candidate = acknowledgement as Partial<
    AppUpdateCandidateBootstrapAcknowledgement
  >;
  return typeof candidate.operationId === "string"
    && (candidate.platform === "linux" || candidate.platform === "win32")
    && (candidate.channel === "canary" || candidate.channel === "stable")
    && typeof candidate.oldVersion === "string"
    && typeof candidate.newVersion === "string"
    && typeof candidate.oldRuntimeGenerationId === "string"
    && typeof candidate.candidateArtifactDigest === "string"
    && typeof candidate.candidateExecutableIdentityDigest === "string"
    && typeof candidate.profileIdentityDigest === "string"
    && typeof candidate.dataIdentityDigest === "string"
    && typeof candidate.handoffToken === "string"
    && TOKEN_PATTERN.test(candidate.handoffToken);
}

function candidateAcknowledgementMatches(
  snapshot: AppUpdateHandoffSnapshot,
  acknowledgement: AppUpdateCandidateBootstrapAcknowledgement,
): boolean {
  return acknowledgement.operationId === snapshot.operationId
    && acknowledgement.platform === snapshot.platform
    && acknowledgement.channel === snapshot.channel
    && acknowledgement.oldVersion === snapshot.oldVersion
    && acknowledgement.newVersion === snapshot.newVersion
    && acknowledgement.oldRuntimeGenerationId
      === snapshot.oldRuntimeGenerationId
    && acknowledgement.candidateArtifactDigest
      === snapshot.candidateArtifactDigest
    && acknowledgement.candidateExecutableIdentityDigest
      === snapshot.candidateExecutableIdentityDigest
    && acknowledgement.profileIdentityDigest === snapshot.profileIdentityDigest
    && acknowledgement.dataIdentityDigest === snapshot.dataIdentityDigest
    && appUpdateHandoffTokenMatches(snapshot, acknowledgement.handoffToken);
}

function shortIdentityTag(kind: string, value: string): string {
  return createHash("sha256")
    .update(`inertia.app-update-handoff.${kind}.v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 12);
}

export function createAppUpdateHandoffToken(): string {
  return randomBytes(32).toString("base64url");
}

export function appUpdateHandoffTokenDigest(token: string): string | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  return createHash("sha256")
    .update("inertia.app-update-handoff.token.v1\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

export function appUpdateHandoffTokenMatches(
  snapshot: AppUpdateHandoffSnapshot,
  token: string,
): boolean {
  const actual = appUpdateHandoffTokenDigest(token);
  if (!actual || !DIGEST_PATTERN.test(snapshot.handoffTokenDigest)) return false;
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(snapshot.handoffTokenDigest, "hex"),
  );
}

function tokenReceiptPayload(
  receipt: Omit<AppUpdateHandoffTokenReceipt, "checksum">,
): Omit<AppUpdateHandoffTokenReceipt, "checksum"> {
  return {
    schemaVersion: 1,
    operationId: receipt.operationId,
    handoffToken: receipt.handoffToken,
    createdAt: receipt.createdAt,
    deadlineAt: receipt.deadlineAt,
  };
}

function tokenReceiptChecksum(
  receipt: Omit<AppUpdateHandoffTokenReceipt, "checksum">,
): string {
  return createHash("sha256")
    .update("inertia.app-update-handoff.secret-receipt.v1\0", "utf8")
    .update(JSON.stringify(tokenReceiptPayload(receipt)), "utf8")
    .digest("hex");
}

export function appUpdateHandoffTokenReceiptForSnapshot(
  snapshot: AppUpdateHandoffSnapshot,
  handoffToken: string,
): AppUpdateHandoffTokenReceipt | null {
  if (!appUpdateHandoffTokenMatches(snapshot, handoffToken)) return null;
  const payload = tokenReceiptPayload({
    schemaVersion: 1,
    operationId: snapshot.operationId,
    handoffToken,
    createdAt: snapshot.createdAt,
    deadlineAt: snapshot.deadlineAt,
  });
  return Object.freeze({
    ...payload,
    checksum: tokenReceiptChecksum(payload),
  });
}

export function serializeAppUpdateHandoffTokenReceipt(
  receipt: AppUpdateHandoffTokenReceipt,
): Buffer {
  return Buffer.from(JSON.stringify({
    ...tokenReceiptPayload(receipt),
    checksum: receipt.checksum,
  }), "utf8");
}

export function parseAppUpdateHandoffTokenReceipt(
  bytes: Buffer,
): AppUpdateHandoffTokenReceipt | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || !exactObjectKeys(value, TOKEN_RECEIPT_KEYS)
    ) return null;
    const candidate = value as Partial<AppUpdateHandoffTokenReceipt>;
    if (
      candidate.schemaVersion !== 1
      || typeof candidate.operationId !== "string"
      || !UUID_PATTERN.test(candidate.operationId)
      || typeof candidate.handoffToken !== "string"
      || !TOKEN_PATTERN.test(candidate.handoffToken)
      || !canonicalTimestamp(candidate.createdAt)
      || !canonicalTimestamp(candidate.deadlineAt)
      || Date.parse(candidate.deadlineAt) <= Date.parse(candidate.createdAt)
      || Date.parse(candidate.deadlineAt) - Date.parse(candidate.createdAt)
        > MAX_HANDOFF_LIFETIME_MS
      || typeof candidate.checksum !== "string"
      || !DIGEST_PATTERN.test(candidate.checksum)
    ) return null;
    const receipt = candidate as AppUpdateHandoffTokenReceipt;
    if (tokenReceiptChecksum(receipt) !== receipt.checksum) return null;
    return Object.freeze({ ...receipt });
  } catch {
    return null;
  }
}

export function appUpdateHandoffTokenReceiptMatches(
  receipt: AppUpdateHandoffTokenReceipt,
  snapshot: AppUpdateHandoffSnapshot,
): boolean {
  return receipt.operationId === snapshot.operationId
    && receipt.createdAt === snapshot.createdAt
    && receipt.deadlineAt === snapshot.deadlineAt
    && appUpdateHandoffTokenMatches(snapshot, receipt.handoffToken);
}

export function appUpdateHandoffTokenReceiptsEqual(
  left: AppUpdateHandoffTokenReceipt,
  right: AppUpdateHandoffTokenReceipt,
): boolean {
  return left.checksum === right.checksum
    && serializeAppUpdateHandoffTokenReceipt(left).equals(
      serializeAppUpdateHandoffTokenReceipt(right),
    );
}

export function appUpdateHandoffOwner(
  snapshot: AppUpdateHandoffSnapshot,
): AppUpdateHandoffOwner {
  return Object.freeze({
    operationId: snapshot.operationId,
    revision: snapshot.revision,
    checksum: snapshot.checksum,
  });
}

/**
 * Durable cross-version update authority. This module deliberately does not
 * launch a candidate: the updater must wire an exact candidate acknowledgement
 * before advancing the bootstrap-validation phase.
 */
export class AppUpdateHandoffJournal {
  private readonly root: DirectRuntimeJournalRoot;
  private readonly clock: () => Date;
  private readonly hooks?: DirectRuntimeJournalTestHooks;

  constructor(
    dataDirectory: string,
    options: AppUpdateHandoffJournalOptions = {},
  ) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
    this.clock = options.clock ?? (() => new Date());
    this.hooks = options.testHooks;
  }

  private names(): string[] {
    if (!directRuntimeJournalRootIsPinned(this.root)) {
      throw new Error("The app update handoff journal root identity changed.");
    }
    const names = listDirectRuntimeJournalLeaves(
      this.root,
      HANDOFF_PREFIX,
      MAX_HANDOFF_LEAVES,
    );
    for (const name of names) {
      if (
        name !== HANDOFF_CANONICAL
        && name !== HANDOFF_CONSUME
        && !proposalMatch(name)
      ) throw new Error("The app update handoff journal contains a foreign entry.");
    }
    return names;
  }

  private recoverPublisherTemporary(name: string, checksum: string): void {
    let publishing;
    try {
      publishing = readSnapshotLeaf(this.root, name, this.hooks);
    } catch (error) {
      if (discardDirectRuntimeJournalLeaf(this.root, name, this.hooks)) return;
      throw error;
    }
    if (!publishing) return;
    if (publishing.snapshot.checksum !== checksum) {
      if (unlinkDirectRuntimeJournalLeaf(
        this.root,
        name,
        publishing.leaf.identity,
        this.hooks,
      )) return;
      throw new Error("An invalid app update handoff publisher could not be retired.");
    }
    const targetName = proposalNames(checksum).canonical;
    const target = readSnapshotLeaf(this.root, targetName, this.hooks);
    if (target) {
      if (!snapshotMatches(target.snapshot, publishing.snapshot)) {
        throw new Error("App update handoff publishers conflict.");
      }
      if (!unlinkDirectRuntimeJournalLeaf(
        this.root,
        name,
        publishing.leaf.identity,
        this.hooks,
      )) throw new Error("An app update handoff publisher could not be retired.");
      return;
    }
    if (!renameDirectRuntimeJournalLeaf(
      this.root,
      name,
      targetName,
      publishing.leaf.identity,
      this.hooks,
    )) throw new Error("An app update handoff publisher could not be recovered.");
  }

  private recoverConsume(names: readonly string[]): AppUpdateHandoffSnapshot | undefined {
    if (!names.includes(HANDOFF_CONSUME)) return undefined;
    if (names.length !== 1) {
      throw new Error("The app update handoff consume authority conflicts.");
    }
    const consuming = readSnapshotLeaf(this.root, HANDOFF_CONSUME, this.hooks);
    if (!consuming || !terminalPhase(consuming.snapshot.phase)) {
      throw new Error("The app update handoff consume authority is invalid.");
    }
    if (!unlinkDirectRuntimeJournalLeaf(
      this.root,
      HANDOFF_CONSUME,
      consuming.leaf.identity,
      this.hooks,
    )) throw new Error("The app update handoff consume authority could not be retired.");
    return consuming.snapshot;
  }

  private recover(): AppUpdateHandoffSnapshot | null {
    for (let attempt = 0; attempt < MAX_HANDOFF_LEAVES; attempt += 1) {
      const names = this.names();
      if (this.recoverConsume(names)) return null;

      const temporary = names
        .map((name) => ({ name, match: proposalMatch(name) }))
        .filter(({ match }) => match?.temporary);
      if (temporary.length > 0) {
        for (const { name, match } of temporary) {
          this.recoverPublisherTemporary(name, match!.checksum);
        }
        continue;
      }

      const canonical = readSnapshotLeaf(
        this.root,
        HANDOFF_CANONICAL,
        this.hooks,
      );
      const proposals = names
        .map((name) => ({ name, match: proposalMatch(name) }))
        .filter(({ match }) => match && !match.temporary)
        .map(({ name, match }) => {
          const proposal = readSnapshotLeaf(this.root, name, this.hooks);
          if (!proposal || proposal.snapshot.checksum !== match!.checksum) {
            throw new Error("An app update handoff proposal is invalid.");
          }
          return { name, ...proposal };
        });

      if (!canonical) {
        if (proposals.length === 0) return null;
        if (proposals.length !== 1) {
          throw new Error("App update handoff preparation is ambiguous.");
        }
        const proposal = proposals[0]!;
        if (
          proposal.snapshot.phase !== "prepared"
          || proposal.snapshot.revision !== 1
          || proposal.snapshot.previousChecksum !== null
        ) throw new Error("An app update handoff proposal has no predecessor.");
        if (!renameDirectRuntimeJournalLeaf(
          this.root,
          proposal.name,
          HANDOFF_CANONICAL,
          proposal.leaf.identity,
          this.hooks,
        )) throw new Error("App update handoff preparation could not be committed.");
        continue;
      }

      const viable: typeof proposals = [];
      let retiredStaleProposal = false;
      for (const proposal of proposals) {
        if (snapshotMatches(canonical.snapshot, proposal.snapshot)) {
          if (!unlinkDirectRuntimeJournalLeaf(
            this.root,
            proposal.name,
            proposal.leaf.identity,
            this.hooks,
          )) throw new Error("A duplicate app update handoff proposal could not be retired.");
          retiredStaleProposal = true;
          continue;
        }
        if (!immutableIdentityMatches(canonical.snapshot, proposal.snapshot)) {
          throw new Error("An app update handoff proposal has a stale identity.");
        }
        if (proposal.snapshot.revision <= canonical.snapshot.revision) {
          if (!unlinkDirectRuntimeJournalLeaf(
            this.root,
            proposal.name,
            proposal.leaf.identity,
            this.hooks,
          )) throw new Error("A stale app update handoff proposal could not be retired.");
          retiredStaleProposal = true;
          continue;
        }
        if (!immediateSuccessor(canonical.snapshot, proposal.snapshot)) {
          throw new Error("An app update handoff proposal is out of order.");
        }
        viable.push(proposal);
      }
      if (viable.length > 1) {
        throw new Error("App update handoff transition is ambiguous.");
      }
      if (viable.length === 1) {
        const proposal = viable[0]!;
        if (!renameDirectRuntimeJournalLeaf(
          this.root,
          proposal.name,
          HANDOFF_CANONICAL,
          proposal.leaf.identity,
          this.hooks,
        )) throw new Error("App update handoff transition could not be committed.");
        continue;
      }
      if (retiredStaleProposal) continue;
      return canonical.snapshot;
    }
    throw new Error("The app update handoff recovery bound was exceeded.");
  }

  private publishProposal(snapshot: AppUpdateHandoffSnapshot): boolean {
    const names = proposalNames(snapshot.checksum);
    return writeDirectRuntimeJournalLeaf(
      this.root,
      names.temporary,
      names.canonical,
      serializeSnapshot(snapshot),
      this.hooks,
    );
  }

  current(): AppUpdateHandoffSnapshot | null {
    return this.recover();
  }

  private diagnosticSnapshot(): AppUpdateHandoffSnapshot | null {
    const names = this.names();
    if (names.includes(HANDOFF_CONSUME)) {
      if (names.length !== 1) {
        throw new Error("The app update handoff consume authority conflicts.");
      }
      const consuming = readSnapshotLeaf(
        this.root,
        HANDOFF_CONSUME,
        this.hooks,
      );
      if (!consuming || !terminalPhase(consuming.snapshot.phase)) {
        throw new Error("The app update handoff consume authority is invalid.");
      }
      return consuming.snapshot;
    }
    if (!names.includes(HANDOFF_CANONICAL)) return null;
    return readSnapshotLeaf(
      this.root,
      HANDOFF_CANONICAL,
      this.hooks,
    )?.snapshot ?? null;
  }

  prepare(
    preparation: AppUpdateHandoffPreparation,
  ): AppUpdateHandoffSnapshot | null {
    if (!validPreparation(preparation)) return null;
    const prepared = createSnapshot(
      preparation,
      "prepared",
      1,
      preparation.createdAt,
      null,
    );
    const current = this.recover();
    if (current) {
      return snapshotMatches(current, prepared) ? current : null;
    }
    if (!this.publishProposal(prepared)) return null;
    const committed = this.recover();
    return committed && snapshotMatches(committed, prepared) ? committed : null;
  }

  private transitionOwned(
    owner: AppUpdateHandoffOwner,
    nextPhase: AppUpdateHandoffPhase,
    transitionedAt: string,
    authorize: (snapshot: AppUpdateHandoffSnapshot) => boolean,
  ): AppUpdateHandoffSnapshot | null {
    if (
      !validOwner(owner)
      || !validPhase(nextPhase)
      || !canonicalTimestamp(transitionedAt)
    ) return null;
    const current = this.recover();
    if (!current || !authorize(current)) return null;
    if (!ownerMatches(owner, current)) {
      return current.operationId === owner.operationId
        && current.revision === owner.revision + 1
        && current.previousChecksum === owner.checksum
        && current.phase === nextPhase
        ? current
        : null;
    }
    if (nextPhase === current.phase) return current;
    if (
      !appUpdateHandoffCanTransition(current.platform, current.phase, nextPhase)
      || Date.parse(transitionedAt) < Date.parse(current.transitionedAt)
      || (!rollbackPhase(nextPhase)
        && Date.parse(transitionedAt) > Date.parse(current.deadlineAt))
    ) return null;
    const proposal = createSnapshot(
      preparationFrom(current),
      nextPhase,
      current.revision + 1,
      transitionedAt,
      current.checksum,
    );
    if (!this.publishProposal(proposal)) return null;
    const committed = this.recover();
    return committed && snapshotMatches(committed, proposal) ? committed : null;
  }

  transition(
    owner: AppUpdateHandoffOwner,
    nextPhase: AppUpdateHandoffPhase,
    transitionedAt = this.clock().toISOString(),
  ): AppUpdateHandoffSnapshot | null {
    // Bootstrap validation is token-bound and cannot be advanced through the
    // generic lifecycle API.
    if (nextPhase === "candidate-bootstrap-validated") return null;
    return this.transitionOwned(owner, nextPhase, transitionedAt, () => true);
  }

  acknowledgeCandidateBootstrap(
    owner: AppUpdateHandoffOwner,
    acknowledgement: AppUpdateCandidateBootstrapAcknowledgement,
    transitionedAt = this.clock().toISOString(),
  ): AppUpdateHandoffSnapshot | null {
    if (!validCandidateAcknowledgement(acknowledgement)) return null;
    return this.transitionOwned(
      owner,
      "candidate-bootstrap-validated",
      transitionedAt,
      (snapshot) => candidateAcknowledgementMatches(snapshot, acknowledgement),
    );
  }

  retire(owner: AppUpdateHandoffOwner): boolean {
    if (!validOwner(owner)) return false;
    const existingConsume = readSnapshotLeaf(
      this.root,
      HANDOFF_CONSUME,
      this.hooks,
    );
    if (existingConsume) {
      return ownerMatches(owner, existingConsume.snapshot)
        && terminalPhase(existingConsume.snapshot.phase)
        && unlinkDirectRuntimeJournalLeaf(
          this.root,
          HANDOFF_CONSUME,
          existingConsume.leaf.identity,
          this.hooks,
        );
    }
    const current = this.recover();
    if (
      !current
      || !ownerMatches(owner, current)
      || !terminalPhase(current.phase)
    ) return false;
    const source = readSnapshotLeaf(
      this.root,
      HANDOFF_CANONICAL,
      this.hooks,
    );
    if (!source || !snapshotMatches(source.snapshot, current)) return false;
    if (!renameDirectRuntimeJournalLeaf(
      this.root,
      HANDOFF_CANONICAL,
      HANDOFF_CONSUME,
      source.leaf.identity,
      this.hooks,
    )) return false;
    const consuming = readSnapshotLeaf(
      this.root,
      HANDOFF_CONSUME,
      this.hooks,
    );
    return !!consuming
      && snapshotMatches(consuming.snapshot, current)
      && unlinkDirectRuntimeJournalLeaf(
        this.root,
        HANDOFF_CONSUME,
        consuming.leaf.identity,
        this.hooks,
      );
  }

  /** Safe projection for future startup/UI diagnostics; no tokens or path digests. */
  diagnostic(at = this.clock()): AppUpdateHandoffDiagnostic {
    // Diagnostics must never acquire or reconcile update authority. In-flight
    // proposal leaves remain untouched for the singleton owner to recover.
    const snapshot = this.diagnosticSnapshot();
    if (!snapshot) return { state: "none" };
    return Object.freeze({
      state: terminalPhase(snapshot.phase)
        ? "terminal"
        : rollbackPhase(snapshot.phase) ? "rollback" : "active",
      phase: snapshot.phase,
      platform: snapshot.platform,
      channel: snapshot.channel,
      oldVersion: snapshot.oldVersion,
      newVersion: snapshot.newVersion,
      operationTag: shortIdentityTag("operation", snapshot.operationId),
      oldRuntimeGenerationTag: shortIdentityTag(
        "runtime-generation",
        snapshot.oldRuntimeGenerationId,
      ),
      revision: snapshot.revision,
      createdAt: snapshot.createdAt,
      deadlineAt: snapshot.deadlineAt,
      transitionedAt: snapshot.transitionedAt,
      expired: Number.isFinite(at.getTime())
        && at.getTime() > Date.parse(snapshot.deadlineAt),
    });
  }
}
