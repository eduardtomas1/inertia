export interface WorktreeFilesystemIdentity {
  device: string;
  inode: string;
  birthtimeNs: string;
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

function isPlainRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => typeof key === "string" && expectedKeys.includes(key))
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === "string"
    && DECIMAL_IDENTITY.test(value)
    && BigInt(value) > 0n;
}

export function isWorktreeFilesystemIdentity(
  value: unknown,
): value is WorktreeFilesystemIdentity {
  return isPlainRecordWithExactKeys(value, [
    "device",
    "inode",
    "birthtimeNs",
  ])
    && isPositiveDecimal(value.device)
    && isPositiveDecimal(value.inode)
    && isPositiveDecimal(value.birthtimeNs);
}

export function isWorktreeFilesystemReceipt(
  value: unknown,
): value is WorktreeFilesystemReceipt {
  return isPlainRecordWithExactKeys(value, [
    "version",
    "worktreesDirectory",
    "adminDirectory",
  ])
    && value.version === 1
    && isWorktreeFilesystemIdentity(value.worktreesDirectory)
    && isWorktreeFilesystemIdentity(value.adminDirectory);
}

function canonicalWorktreeFilesystemReceipt(
  value: WorktreeFilesystemReceipt,
): WorktreeFilesystemReceipt {
  return {
    version: 1,
    worktreesDirectory: {
      device: value.worktreesDirectory.device,
      inode: value.worktreesDirectory.inode,
      birthtimeNs: value.worktreesDirectory.birthtimeNs,
    },
    adminDirectory: {
      device: value.adminDirectory.device,
      inode: value.adminDirectory.inode,
      birthtimeNs: value.adminDirectory.birthtimeNs,
    },
  };
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
    if (!isWorktreeFilesystemReceipt(parsed)) return null;
    return canonicalWorktreeFilesystemReceipt(parsed);
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
  const serialized = JSON.stringify(canonicalWorktreeFilesystemReceipt(value));
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
    && left.birthtimeNs === right.birthtimeNs;
}
