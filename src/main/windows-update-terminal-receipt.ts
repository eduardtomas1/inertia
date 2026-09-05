import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
} from "../node/direct-runtime-journal.js";
import {
  appUpdateHandoffIdentityMatches,
  type AppUpdateHandoffSnapshot,
} from "./app-update-handoff.js";

const RECEIPT_SCHEMA_VERSION = 1 as const;
const RECEIPT_PREFIX = ".app-update-terminal-receipt-";
const SUPERVISOR_PREFIX = ".app-update-supervisor-";
const MAX_RECEIPT_BYTES = 2 * 1_024;
const MAX_RECEIPT_LEAVES = 2;
const MAX_SUPERVISOR_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CREATION_BITS_PATTERN = /^[1-9][0-9]{0,19}$/u;

export interface WindowsUpdateOperationClaimPayload {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly handoffChecksum: string;
  readonly launchId: string;
  readonly supervisorDigest: string;
  readonly deadlineAt: string;
}

export interface WindowsUpdateOperationClaim
  extends WindowsUpdateOperationClaimPayload {
  readonly authenticationTag: string;
}

const OPERATION_CLAIM_KEYS = [
  "authenticationTag",
  "deadlineAt",
  "handoffChecksum",
  "launchId",
  "operationId",
  "schemaVersion",
  "supervisorDigest",
] as const;

export type WindowsUpdateTerminalOutcome =
  | "success"
  | "clean-failure"
  | "quarantined";

export interface WindowsUpdateTerminalReceiptPayload {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly handoffChecksum: string;
  readonly outcome: WindowsUpdateTerminalOutcome;
  readonly installerExitCode: number | null;
  readonly installerDigest: string;
  readonly supervisorDigest: string;
  readonly executableDigest: string | null;
  readonly parentCreationTimeBits: string;
  readonly completedAt: string;
}

export interface WindowsUpdateTerminalReceipt
  extends WindowsUpdateTerminalReceiptPayload {
  readonly authenticationTag: string;
}

const RECEIPT_KEYS = [
  "authenticationTag",
  "completedAt",
  "executableDigest",
  "handoffChecksum",
  "installerDigest",
  "installerExitCode",
  "operationId",
  "outcome",
  "parentCreationTimeBits",
  "schemaVersion",
  "supervisorDigest",
] as const;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function validOperationClaimPayload(
  value: Partial<WindowsUpdateOperationClaimPayload>,
): value is WindowsUpdateOperationClaimPayload {
  return value.schemaVersion === RECEIPT_SCHEMA_VERSION
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
    && typeof value.handoffChecksum === "string"
    && DIGEST_PATTERN.test(value.handoffChecksum)
    && typeof value.launchId === "string"
    && UUID_PATTERN.test(value.launchId)
    && typeof value.supervisorDigest === "string"
    && DIGEST_PATTERN.test(value.supervisorDigest)
    && canonicalTimestamp(value.deadlineAt);
}

function operationClaimAuthenticationPayload(
  claim: WindowsUpdateOperationClaimPayload,
): string {
  return JSON.stringify([
    claim.schemaVersion,
    claim.operationId,
    claim.handoffChecksum,
    claim.launchId,
    claim.supervisorDigest,
    claim.deadlineAt,
  ]);
}

export function windowsUpdateOperationClaimAuthenticationTag(
  claim: WindowsUpdateOperationClaimPayload,
  handoffToken: string,
): string | null {
  if (!validOperationClaimPayload(claim) || !TOKEN_PATTERN.test(handoffToken)) {
    return null;
  }
  return createHmac("sha256", Buffer.from(handoffToken, "utf8"))
    .update("inertia.windows-update-operation-claim.v1\0", "utf8")
    .update(operationClaimAuthenticationPayload(claim), "utf8")
    .digest("hex");
}

export function parseWindowsUpdateOperationClaim(
  bytes: Buffer,
): WindowsUpdateOperationClaim | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || !exactKeys(value, OPERATION_CLAIM_KEYS)
    ) return null;
    const claim = value as Partial<WindowsUpdateOperationClaim>;
    return typeof claim.authenticationTag === "string"
      && DIGEST_PATTERN.test(claim.authenticationTag)
      && validOperationClaimPayload(claim)
      ? claim as WindowsUpdateOperationClaim
      : null;
  } catch {
    return null;
  }
}

function validExitCode(value: unknown): value is number | null {
  return value === null
    || (
      Number.isSafeInteger(value)
      && Number(value) >= 0
      && Number(value) <= 0xffff_ffff
    );
}

function validOutcome(value: unknown): value is WindowsUpdateTerminalOutcome {
  return value === "success"
    || value === "clean-failure"
    || value === "quarantined";
}

function validPayload(
  value: Partial<WindowsUpdateTerminalReceiptPayload>,
): value is WindowsUpdateTerminalReceiptPayload {
  return value.schemaVersion === RECEIPT_SCHEMA_VERSION
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
    && typeof value.handoffChecksum === "string"
    && DIGEST_PATTERN.test(value.handoffChecksum)
    && validOutcome(value.outcome)
    && validExitCode(value.installerExitCode)
    && typeof value.installerDigest === "string"
    && DIGEST_PATTERN.test(value.installerDigest)
    && typeof value.supervisorDigest === "string"
    && DIGEST_PATTERN.test(value.supervisorDigest)
    && (
      value.executableDigest === null
      || (
        typeof value.executableDigest === "string"
        && DIGEST_PATTERN.test(value.executableDigest)
      )
    )
    && typeof value.parentCreationTimeBits === "string"
    && CREATION_BITS_PATTERN.test(value.parentCreationTimeBits)
    && canonicalTimestamp(value.completedAt)
    && (
      value.outcome !== "success"
      || (
        value.installerExitCode === 0
        && value.executableDigest !== null
      )
    )
    && (
      value.outcome !== "clean-failure"
      || (
        value.installerExitCode === null
        && value.executableDigest !== null
      )
    );
}

function authenticationPayload(
  receipt: WindowsUpdateTerminalReceiptPayload,
): string {
  return JSON.stringify([
    receipt.schemaVersion,
    receipt.operationId,
    receipt.handoffChecksum,
    receipt.outcome,
    receipt.installerExitCode,
    receipt.installerDigest,
    receipt.supervisorDigest,
    receipt.executableDigest,
    receipt.parentCreationTimeBits,
    receipt.completedAt,
  ]);
}

export function windowsUpdateTerminalAuthenticationTag(
  receipt: WindowsUpdateTerminalReceiptPayload,
  handoffToken: string,
): string | null {
  if (!validPayload(receipt) || !TOKEN_PATTERN.test(handoffToken)) return null;
  return createHmac("sha256", Buffer.from(handoffToken, "utf8"))
    .update("inertia.windows-update-terminal.v1\0", "utf8")
    .update(authenticationPayload(receipt), "utf8")
    .digest("hex");
}

export function createWindowsUpdateTerminalReceipt(
  payload: WindowsUpdateTerminalReceiptPayload,
  handoffToken: string,
): WindowsUpdateTerminalReceipt {
  const authenticationTag = windowsUpdateTerminalAuthenticationTag(
    payload,
    handoffToken,
  );
  if (!authenticationTag) {
    throw new Error("The Windows update terminal receipt is invalid.");
  }
  return Object.freeze({ ...payload, authenticationTag });
}

export function parseWindowsUpdateTerminalReceipt(
  bytes: Buffer,
): WindowsUpdateTerminalReceipt | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || !exactKeys(value, RECEIPT_KEYS)
    ) return null;
    const receipt = value as Partial<WindowsUpdateTerminalReceipt>;
    return typeof receipt.authenticationTag === "string"
      && DIGEST_PATTERN.test(receipt.authenticationTag)
      && validPayload(receipt)
      ? receipt as WindowsUpdateTerminalReceipt
      : null;
  } catch {
    return null;
  }
}

export function serializeWindowsUpdateTerminalReceipt(
  receipt: WindowsUpdateTerminalReceipt,
): Buffer {
  if (!parseWindowsUpdateTerminalReceipt(
    Buffer.from(JSON.stringify(receipt), "utf8"),
  )) throw new Error("The Windows update terminal receipt is invalid.");
  return Buffer.from(JSON.stringify(receipt), "utf8");
}

export function windowsUpdateTerminalReceiptMatches(options: {
  readonly receipt: WindowsUpdateTerminalReceipt;
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly handoffToken: string;
  readonly outcome: "success" | "clean-failure";
  readonly executableDigest: string;
}): boolean {
  const { receipt, snapshot } = options;
  const expectedTag = windowsUpdateTerminalAuthenticationTag(
    receipt,
    options.handoffToken,
  );
  const actualTag = Buffer.from(receipt.authenticationTag, "hex");
  const expectedTagBytes = expectedTag
    ? Buffer.from(expectedTag, "hex")
    : Buffer.alloc(0);
  return snapshot.platform === "win32"
    && snapshot.phase === "old-generation-cleanup-confirmed"
    && receipt.operationId === snapshot.operationId
    && receipt.handoffChecksum === snapshot.checksum
    && receipt.outcome === options.outcome
    && receipt.installerDigest === snapshot.candidateArtifactDigest
    && receipt.executableDigest === options.executableDigest
    && Date.parse(receipt.completedAt) >= Date.parse(snapshot.transitionedAt)
    && Date.parse(receipt.completedAt) <= Date.parse(snapshot.deadlineAt)
    && expectedTagBytes.byteLength === 32
    && actualTag.byteLength === expectedTagBytes.byteLength
    && timingSafeEqual(actualTag, expectedTagBytes);
}

/**
 * Authenticates the native supervisor's durable fail-closed outcome. Unlike a
 * success or clean-failure receipt, a quarantine can be published at or after
 * the handoff deadline because it records that installer completion was not
 * safely established. It never grants rollback, candidate, or cleanup
 * authority; callers may use it only to surface the exact startup blocker.
 */
export function windowsUpdateTerminalReceiptMatchesQuarantine(options: {
  readonly receipt: WindowsUpdateTerminalReceipt;
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly handoffToken: string;
}): boolean {
  const { receipt, snapshot } = options;
  const expectedTag = windowsUpdateTerminalAuthenticationTag(
    receipt,
    options.handoffToken,
  );
  const actualTag = Buffer.from(receipt.authenticationTag, "hex");
  const expectedTagBytes = expectedTag
    ? Buffer.from(expectedTag, "hex")
    : Buffer.alloc(0);
  return snapshot.platform === "win32"
    && snapshot.phase === "old-generation-cleanup-confirmed"
    && receipt.operationId === snapshot.operationId
    && receipt.handoffChecksum === snapshot.checksum
    && receipt.outcome === "quarantined"
    && receipt.installerDigest === snapshot.candidateArtifactDigest
    && Date.parse(receipt.completedAt) >= Date.parse(snapshot.transitionedAt)
    && expectedTagBytes.byteLength === 32
    && actualTag.byteLength === expectedTagBytes.byteLength
    && timingSafeEqual(actualTag, expectedTagBytes);
}

export function windowsUpdateTerminalReceiptMatchesTransferredAuthority(
  options: {
    readonly receipt: WindowsUpdateTerminalReceipt;
    readonly snapshot: AppUpdateHandoffSnapshot;
    readonly handoffToken: string;
    readonly outcome: "success" | "clean-failure";
    readonly executableDigest: string;
  },
): boolean {
  const { receipt, snapshot } = options;
  const expectedTag = windowsUpdateTerminalAuthenticationTag(
    receipt,
    options.handoffToken,
  );
  const actualTag = Buffer.from(receipt.authenticationTag, "hex");
  const expectedTagBytes = expectedTag
    ? Buffer.from(expectedTag, "hex")
    : Buffer.alloc(0);
  return snapshot.platform === "win32"
    && snapshot.phase === "ownership-transfer-committed"
    && snapshot.previousChecksum !== null
    && receipt.operationId === snapshot.operationId
    && receipt.handoffChecksum === snapshot.previousChecksum
    && receipt.outcome === options.outcome
    && receipt.installerDigest === snapshot.candidateArtifactDigest
    && receipt.executableDigest === options.executableDigest
    && Date.parse(receipt.completedAt) >= Date.parse(snapshot.createdAt)
    && Date.parse(receipt.completedAt) <= Date.parse(snapshot.transitionedAt)
    && Date.parse(receipt.completedAt) <= Date.parse(snapshot.deadlineAt)
    && expectedTagBytes.byteLength === 32
    && actualTag.byteLength === expectedTagBytes.byteLength
    && timingSafeEqual(actualTag, expectedTagBytes);
}

export function windowsUpdateTerminalReceiptMatchesRollbackAuthority(
  options: {
    readonly receipt: WindowsUpdateTerminalReceipt;
    readonly snapshot: AppUpdateHandoffSnapshot;
    readonly handoffToken: string;
    readonly executableDigest: string;
  },
): boolean {
  const { receipt, snapshot } = options;
  const expectedTag = windowsUpdateTerminalAuthenticationTag(
    receipt,
    options.handoffToken,
  );
  const actualTag = Buffer.from(receipt.authenticationTag, "hex");
  const expectedTagBytes = expectedTag
    ? Buffer.from(expectedTag, "hex")
    : Buffer.alloc(0);
  return snapshot.platform === "win32"
    && snapshot.phase === "rollback-completed"
    && snapshot.previousChecksum !== null
    && receipt.operationId === snapshot.operationId
    && receipt.handoffChecksum === snapshot.previousChecksum
    && receipt.outcome === "clean-failure"
    && receipt.installerDigest === snapshot.candidateArtifactDigest
    && receipt.executableDigest === options.executableDigest
    && Date.parse(receipt.completedAt) >= Date.parse(snapshot.createdAt)
    && Date.parse(receipt.completedAt) <= Date.parse(snapshot.transitionedAt)
    && Date.parse(receipt.completedAt) <= Date.parse(snapshot.deadlineAt)
    && expectedTagBytes.byteLength === 32
    && actualTag.byteLength === expectedTagBytes.byteLength
    && timingSafeEqual(actualTag, expectedTagBytes);
}

function operationHash(operationId: string): string {
  if (!UUID_PATTERN.test(operationId)) {
    throw new Error("The Windows update operation identity is invalid.");
  }
  return createHash("sha256").update(operationId, "utf8").digest("hex");
}

export function windowsUpdateTerminalReceiptName(operationId: string): string {
  return `${RECEIPT_PREFIX}${operationHash(operationId)}.json`;
}

export function windowsUpdateTerminalReceiptTemporaryName(
  operationId: string,
): string {
  return `${RECEIPT_PREFIX}${operationHash(operationId)}.publish.tmp`;
}

export function windowsUpdateSupervisorExecutableName(
  operationId: string,
): string {
  return `.app-update-supervisor-${operationHash(operationId)}.exe`;
}

/**
 * Removes only the authenticated pre-terminal claim created by one rejected
 * native launch. A competing launch's claim is deliberately indistinguishable
 * from durable native authority to the caller and is never removed here.
 */
export function retireWindowsUpdateOperationClaim(options: {
  readonly dataDirectory: string;
  readonly operationId: string;
  readonly handoffChecksum: string;
  readonly launchId: string;
  readonly supervisorDigest: string;
  readonly handoffToken: string;
  readonly deadlineAt: string;
}): boolean {
  const root = pinDirectRuntimeJournalRoot(options.dataDirectory);
  const name = windowsUpdateTerminalReceiptTemporaryName(options.operationId);
  const canonical = windowsUpdateTerminalReceiptName(options.operationId);
  const names = listDirectRuntimeJournalLeaves(
    root,
    RECEIPT_PREFIX,
    MAX_RECEIPT_LEAVES,
  );
  // A canonical leaf proves that this operation crossed native admission,
  // even if the exact supervisor exited before the broker sampled it. Unknown
  // receipt leaves are equally ambiguous and must retain native authority.
  if (
    names.includes(canonical)
    || names.some((candidate) => candidate !== canonical && candidate !== name)
  ) return false;
  // The broker caller supplies exact pre-admission child-exit proof. Only that
  // caller may interpret a completely absent receipt namespace as a launch
  // that never acquired the native operation claim.
  if (!names.includes(name)) return names.length === 0;
  const leaf = readDirectRuntimeJournalLeaf(root, name, MAX_RECEIPT_BYTES);
  if (!leaf) return false;
  const claim = parseWindowsUpdateOperationClaim(leaf.bytes);
  const expectedTag = claim
    ? windowsUpdateOperationClaimAuthenticationTag(claim, options.handoffToken)
    : null;
  const actualTag = claim
    ? Buffer.from(claim.authenticationTag, "hex")
    : Buffer.alloc(0);
  const expectedTagBytes = expectedTag
    ? Buffer.from(expectedTag, "hex")
    : Buffer.alloc(0);
  const retired = !!claim
    && claim.operationId === options.operationId
    && claim.handoffChecksum === options.handoffChecksum
    && claim.launchId === options.launchId
    && claim.supervisorDigest === options.supervisorDigest
    && claim.deadlineAt === options.deadlineAt
    && expectedTagBytes.byteLength === 32
    && actualTag.byteLength === expectedTagBytes.byteLength
    && timingSafeEqual(actualTag, expectedTagBytes)
    && unlinkDirectRuntimeJournalLeaf(root, name, leaf.identity);
  if (!retired) return false;
  // Recheck after the exact unlink so a canonical publication that raced the
  // cleanup can never authorize staged-helper retirement.
  return listDirectRuntimeJournalLeaves(
    root,
    RECEIPT_PREFIX,
    MAX_RECEIPT_LEAVES,
  ).length === 0;
}

function receiptsEqual(
  left: WindowsUpdateTerminalReceipt,
  right: WindowsUpdateTerminalReceipt,
): boolean {
  return RECEIPT_KEYS.every((key) => left[key] === right[key]);
}

export class WindowsUpdateTerminalReceiptJournal {
  private readonly root: DirectRuntimeJournalRoot;

  constructor(dataDirectory: string) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
  }

  current(operationId: string): WindowsUpdateTerminalReceipt | null {
    const canonical = windowsUpdateTerminalReceiptName(operationId);
    const temporary = windowsUpdateTerminalReceiptTemporaryName(operationId);
    const names = listDirectRuntimeJournalLeaves(
      this.root,
      RECEIPT_PREFIX,
      MAX_RECEIPT_LEAVES,
    );
    if (
      names.some((name) => name !== canonical && name !== temporary)
      || names.includes(temporary)
    ) throw new Error("Windows update terminal receipt storage is ambiguous.");
    if (!names.includes(canonical)) return null;
    const leaf = readDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      MAX_RECEIPT_BYTES,
    );
    const receipt = leaf && parseWindowsUpdateTerminalReceipt(leaf.bytes);
    if (!receipt || receipt.operationId !== operationId) {
      throw new Error("The Windows update terminal receipt is invalid.");
    }
    return receipt;
  }

  retire(
    operationId: string,
    expected: WindowsUpdateTerminalReceipt,
  ): boolean {
    const canonical = windowsUpdateTerminalReceiptName(operationId);
    const temporary = windowsUpdateTerminalReceiptTemporaryName(operationId);
    const names = listDirectRuntimeJournalLeaves(
      this.root,
      RECEIPT_PREFIX,
      MAX_RECEIPT_LEAVES,
    );
    if (
      names.some((name) => name !== canonical && name !== temporary)
      || names.includes(temporary)
    ) return false;
    if (!names.includes(canonical)) return true;
    const leaf = readDirectRuntimeJournalLeaf(
      this.root,
      canonical,
      MAX_RECEIPT_BYTES,
    );
    const current = leaf && parseWindowsUpdateTerminalReceipt(leaf.bytes);
    return !!leaf
      && !!current
      && receiptsEqual(current, expected)
      && unlinkDirectRuntimeJournalLeaf(this.root, canonical, leaf.identity);
  }
}

export function windowsUpdateSupervisorArtifactPresent(options: {
  readonly dataDirectory: string;
  readonly operationId: string;
}): boolean {
  const root = pinDirectRuntimeJournalRoot(options.dataDirectory);
  const expectedName = windowsUpdateSupervisorExecutableName(
    options.operationId,
  );
  const names = listDirectRuntimeJournalLeaves(root, SUPERVISOR_PREFIX, 2);
  if (names.some((name) => name !== expectedName)) {
    throw new Error("Windows update supervisor storage is ambiguous.");
  }
  return names.includes(expectedName);
}

/**
 * Retires the helper before its receipt. Consequently an absent receipt plus
 * an absent helper is an idempotent completed cleanup, while a lone helper is
 * never accepted as one.
 */
export async function retireWindowsUpdateSupervisorArtifacts(options: {
  readonly dataDirectory: string;
  readonly receipt: WindowsUpdateTerminalReceipt;
  readonly retries?: number;
  readonly retryDelayMs?: number;
}): Promise<boolean> {
  if (!await retireWindowsUpdateSupervisorHelper({
    dataDirectory: options.dataDirectory,
    operationId: options.receipt.operationId,
    supervisorDigest: options.receipt.supervisorDigest,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
  })) return false;
  const root = pinDirectRuntimeJournalRoot(options.dataDirectory);
  const expectedName = windowsUpdateSupervisorExecutableName(
    options.receipt.operationId,
  );
  if (!new WindowsUpdateTerminalReceiptJournal(options.dataDirectory).retire(
    options.receipt.operationId,
    options.receipt,
  )) return false;
  return !readDirectRuntimeJournalLeaf(
    root,
    expectedName,
    MAX_SUPERVISOR_BYTES,
  );
}

export async function retireWindowsUpdateSupervisorHelper(options: {
  readonly dataDirectory: string;
  readonly operationId: string;
  readonly supervisorDigest: string;
  readonly retries?: number;
  readonly retryDelayMs?: number;
}): Promise<boolean> {
  if (!DIGEST_PATTERN.test(options.supervisorDigest)) return false;
  const root = pinDirectRuntimeJournalRoot(options.dataDirectory);
  const expectedName = windowsUpdateSupervisorExecutableName(
    options.operationId,
  );
  const names = listDirectRuntimeJournalLeaves(root, SUPERVISOR_PREFIX, 2);
  if (names.some((name) => name !== expectedName)) return false;
  const retries = Math.max(1, Math.min(options.retries ?? 80, 100));
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const helper = readDirectRuntimeJournalLeaf(
      root,
      expectedName,
      MAX_SUPERVISOR_BYTES,
    );
    if (!helper) break;
    if (
      createHash("sha256").update(helper.bytes).digest("hex")
        !== options.supervisorDigest
    ) return false;
    if (unlinkDirectRuntimeJournalLeaf(root, expectedName, helper.identity)) {
      break;
    }
    if (attempt + 1 < retries) {
      await new Promise<void>((resolveDelay) => {
        setTimeout(
          resolveDelay,
          Math.max(1, options.retryDelayMs ?? 25),
        );
      });
    }
  }
  if (readDirectRuntimeJournalLeaf(root, expectedName, MAX_SUPERVISOR_BYTES)) {
    return false;
  }
  return true;
}

export function windowsUpdateTerminalSnapshotMatches(
  current: AppUpdateHandoffSnapshot,
  expected: AppUpdateHandoffSnapshot,
): boolean {
  return current.checksum === expected.checksum
    && current.revision === expected.revision
    && current.phase === expected.phase
    && appUpdateHandoffIdentityMatches(current, expected);
}
