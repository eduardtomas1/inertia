export type WorktreeIdentityTimestampKind = "birthtime" | "ctime";

export interface WorktreeFilesystemIdentity {
  device: string;
  inode: string;
  timestampKind: WorktreeIdentityTimestampKind;
  timestampNs: string;
}

export interface WorktreeFilesystemReceipt {
  version: 1;
  worktreesDirectory: WorktreeFilesystemIdentity;
  adminDirectory: WorktreeFilesystemIdentity;
}

export const MAX_WORKTREE_FILESYSTEM_RECEIPT_BYTES = 1_024;
const MAX_DECIMAL_IDENTITY_DIGITS = 32;
const DECIMAL_IDENTITY = new RegExp(
  `^(?:0|[1-9][0-9]{0,${MAX_DECIMAL_IDENTITY_DIGITS - 1}})$`,
  "u",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === "string"
    && DECIMAL_IDENTITY.test(value)
    && BigInt(value) > 0n;
}

export function isWorktreeFilesystemIdentity(
  value: unknown,
): value is WorktreeFilesystemIdentity {
  return isRecord(value)
    && isPositiveDecimal(value.device)
    && isPositiveDecimal(value.inode)
    && (value.timestampKind === "birthtime" || value.timestampKind === "ctime")
    && isPositiveDecimal(value.timestampNs);
}

export function isWorktreeFilesystemReceipt(
  value: unknown,
): value is WorktreeFilesystemReceipt {
  return isRecord(value)
    && value.version === 1
    && isWorktreeFilesystemIdentity(value.worktreesDirectory)
    && isWorktreeFilesystemIdentity(value.adminDirectory);
}

export function parseWorktreeFilesystemReceipt(
  value: string | null,
): WorktreeFilesystemReceipt | null {
  if (
    value === null
    || Buffer.byteLength(value, "utf8") > MAX_WORKTREE_FILESYSTEM_RECEIPT_BYTES
  ) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isWorktreeFilesystemReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeWorktreeFilesystemReceipt(
  value: WorktreeFilesystemReceipt,
): string {
  if (!isWorktreeFilesystemReceipt(value)) {
    throw new Error("The linked-worktree filesystem identity is invalid.");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKTREE_FILESYSTEM_RECEIPT_BYTES) {
    throw new Error("The linked-worktree filesystem identity is too large.");
  }
  return serialized;
}

export function worktreeFilesystemIdentitiesEqual(
  left: WorktreeFilesystemIdentity,
  right: WorktreeFilesystemIdentity,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.timestampKind === right.timestampKind
    && left.timestampNs === right.timestampNs;
}
