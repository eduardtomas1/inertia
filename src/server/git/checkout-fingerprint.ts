import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";

import { mayBeInsideGitRepository, repositoryRoot } from "./paths";
import { runGitInspection } from "./runner";
import { GitError, isGitProcessTreeTerminationFailure } from "./types";

/**
 * A read-only fingerprint of a checkout's HEAD, index and dirty worktree,
 * used to notice writes nobody accounts for. It never writes into the
 * repository: no checkpoint refs, no `write-tree`, no index refresh, and no
 * repository filter or hook ever runs.
 */
export const MAX_CHECKOUT_FINGERPRINT_PATHS = 2_000;
export const MAX_CHECKOUT_FINGERPRINT_BYTES = 64 * 1024 * 1024;
/** Keeps every hash-object command line well inside the Windows limit. */
const MAX_HASH_ARGUMENT_CHARS = 24_000;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const FILTER_SETTING = /^filter\.(.+)\.(?:clean|smudge|process|required)$/su;

export interface CapturedCheckoutFingerprint {
  state: "captured";
  root: string;
  head: string | null;
  /** Repository-relative path to an opaque state descriptor; clean paths are absent. */
  entries: ReadonlyMap<string, string>;
}

export type CheckoutFingerprint =
  | CapturedCheckoutFingerprint
  | { state: "truncated"; root: string; reason: string }
  | { state: "unavailable"; reason: string };

export interface CheckoutFingerprintOptions {
  deadlineAt: number;
  signal?: AbortSignal;
}

export interface CheckoutFingerprintDiff {
  headChanged: boolean;
  changedPaths: string[];
}

class FingerprintLimit extends Error {}

interface StatusEntry {
  path: string;
  descriptor: string;
  /** True when the worktree side differs from the index or is untracked. */
  worktree: boolean;
  deleted: boolean;
}

function inspection(options: CheckoutFingerprintOptions, failureMessage: string, maxOutputBytes: number) {
  return { deadlineAt: options.deadlineAt, signal: options.signal, maxOutputBytes, failureMessage };
}

async function filterDriverNames(root: string, options: CheckoutFingerprintOptions): Promise<string[]> {
  const result = await runGitInspection(
    root,
    ["config", "--list", "--name-only", "-z"],
    inspection(options, "Unable to read the repository configuration.", MAX_CONFIG_BYTES),
  );
  const names = new Set<string>();
  for (const name of result.stdout.toString("utf8").split("\0")) {
    const match = FILTER_SETTING.exec(name.trim());
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

async function headOid(root: string, options: CheckoutFingerprintOptions): Promise<string | null> {
  try {
    const result = await runGitInspection(
      root,
      ["rev-parse", "--verify", "-q", "HEAD"],
      inspection(options, "Unable to read the checkout's HEAD.", 256),
    );
    return result.stdout.toString("utf8").trim() || null;
  } catch (error) {
    if (error instanceof GitError && error.code !== "timeout" && !isGitProcessTreeTerminationFailure(error)) {
      return null;
    }
    throw error;
  }
}

/** Parses `status --porcelain=v2 -z --no-renames` records. */
function statusEntries(output: Buffer): StatusEntry[] {
  const fields = output.toString("utf8").split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length === 0 || field.startsWith("# ")) continue;
    const kind = field[0];
    if (kind === "?") {
      entries.push({ path: field.slice(2), descriptor: "?", worktree: true, deleted: false });
      continue;
    }
    const parts = field.split(" ");
    const metaCount = kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : -1;
    if (metaCount < 0 || parts.length <= metaCount) {
      throw new GitError("operation-failed", "Git reported a status record Inertia cannot read.");
    }
    const path = parts.slice(metaCount).join(" ");
    if (kind === "2") index += 1;
    const worktreeCode = parts[1]![1];
    entries.push({
      path,
      descriptor: parts.slice(0, metaCount).join(" "),
      worktree: kind === "u" || (worktreeCode !== "." && worktreeCode !== undefined),
      deleted: worktreeCode === "D",
    });
  }
  return entries;
}

function hashBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const path of paths) {
    const size = path.length + 1;
    if (current.length > 0 && chars + size > MAX_HASH_ARGUMENT_CHARS) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(path);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Hashes raw worktree bytes; `--no-filters` keeps repository clean filters from running. */
async function worktreeDigests(
  root: string,
  entries: readonly StatusEntry[],
  options: CheckoutFingerprintOptions,
): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  const regular: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.worktree) continue;
    if (entry.deleted) {
      digests.set(entry.path, "deleted");
      continue;
    }
    const absolute = join(root, entry.path);
    const info = await lstat(absolute).catch(() => null);
    if (!info) digests.set(entry.path, "missing");
    else if (info.isSymbolicLink()) digests.set(entry.path, `link:${await readlink(absolute).catch(() => "?")}`);
    else if (!info.isFile()) digests.set(entry.path, info.isDirectory() ? "directory" : "special");
    else {
      bytes += info.size;
      if (bytes > MAX_CHECKOUT_FINGERPRINT_BYTES) throw new FingerprintLimit("The changed files are too large to fingerprint.");
      regular.push(entry.path);
    }
  }
  for (const batch of hashBatches(regular)) {
    const result = await runGitInspection(
      root,
      ["hash-object", "--no-filters", "--", ...batch],
      inspection(options, "Unable to fingerprint the changed files.", batch.length * 72),
    );
    const oids = result.stdout.toString("utf8").split("\n").filter(Boolean);
    if (oids.length !== batch.length) {
      throw new GitError("operation-failed", "Git did not fingerprint every changed file.");
    }
    batch.forEach((path, index) => digests.set(path, `blob:${oids[index]}`));
  }
  return digests;
}

export async function captureCheckoutFingerprint(
  checkoutPath: string,
  options: CheckoutFingerprintOptions,
): Promise<CheckoutFingerprint> {
  const pathOptions = { deadlineAt: options.deadlineAt, signal: options.signal };
  if (!await mayBeInsideGitRepository(checkoutPath, pathOptions)) {
    return { state: "unavailable", reason: "This checkout is not a Git repository." };
  }
  let root: string | null = null;
  try {
    root = await repositoryRoot(checkoutPath, pathOptions);
    const disabledFilterDrivers = await filterDriverNames(root, options);
    const head = await headOid(root, options);
    const status = await runGitInspection(
      root,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=dirty"],
      {
        ...inspection(options, "Unable to read the checkout status.", MAX_STATUS_BYTES),
        truncateOutput: true,
        disabledFilterDrivers,
      },
    );
    if (status.truncated) throw new FingerprintLimit("The checkout status is too large to fingerprint.");
    const entries = statusEntries(status.stdout);
    if (entries.length > MAX_CHECKOUT_FINGERPRINT_PATHS) {
      throw new FingerprintLimit(`More than ${MAX_CHECKOUT_FINGERPRINT_PATHS} paths changed.`);
    }
    const digests = await worktreeDigests(root, entries, options);
    return {
      state: "captured",
      root,
      head,
      entries: new Map(entries.map((entry) => [
        entry.path,
        `${entry.descriptor}|${digests.get(entry.path) ?? "index"}`,
      ])),
    };
  } catch (error) {
    if (error instanceof FingerprintLimit && root !== null) {
      return { state: "truncated", root, reason: error.message };
    }
    if (isGitProcessTreeTerminationFailure(error)) throw error;
    if (error instanceof GitError) return { state: "unavailable", reason: error.message };
    throw error;
  }
}

/** Paths whose HEAD, index or worktree state differs between two captures of one checkout. */
export function diffCheckoutFingerprints(
  before: CapturedCheckoutFingerprint,
  after: CapturedCheckoutFingerprint,
): CheckoutFingerprintDiff {
  if (before.root !== after.root) throw new Error("Checkout fingerprints of different repositories cannot be compared.");
  const changed = new Set<string>();
  for (const [path, state] of before.entries) {
    if (after.entries.get(path) !== state) changed.add(path);
  }
  for (const path of after.entries.keys()) {
    if (!before.entries.has(path)) changed.add(path);
  }
  return {
    headChanged: before.head !== after.head,
    changedPaths: [...changed].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}
