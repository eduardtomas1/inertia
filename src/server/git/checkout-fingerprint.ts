import { lstat, readlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isContained, mayBeInsideGitRepository, repositoryRoot } from "./paths";
import { runGitInspection } from "./runner";
import { GitError, isGitProcessTreeTerminationFailure } from "./types";

/**
 * A read-only fingerprint of a checkout's HEAD, its branch, the index and the
 * dirty worktree, including the dirty worktrees of the submodules listed in
 * `.gitmodules`, used to notice writes nobody accounts for. It never writes
 * into the repository: no checkpoint refs, no `write-tree`, no index refresh,
 * and no repository filter or hook ever runs. Ignored files, `.git` internals
 * and submodules nested inside submodules are outside it.
 */
export const MAX_CHECKOUT_FINGERPRINT_PATHS = 2_000;
export const MAX_CHECKOUT_FINGERPRINT_BYTES = 64 * 1024 * 1024;
/** Keeps every hash-object command line well inside the Windows limit. */
const MAX_HASH_ARGUMENT_CHARS = 24_000;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SUBMODULES = 16;
const MAX_GITMODULES_BYTES = 64 * 1024;
const FILTER_SETTING = /^filter\.(.+)\.(?:clean|smudge|process|required)$/su;

export interface CapturedCheckoutFingerprint {
  state: "captured";
  root: string;
  head: string | null;
  /** The branch HEAD names, or null when HEAD is detached. */
  branch: string | null;
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

/** One line of Git output, or null when Git reports that there is none. */
async function optionalLine(
  root: string,
  args: readonly string[],
  options: CheckoutFingerprintOptions,
): Promise<string | null> {
  try {
    const result = await runGitInspection(root, args, inspection(options, "Unable to read the checkout's HEAD.", 1024));
    return result.stdout.toString("utf8").trim() || null;
  } catch (error) {
    if (error instanceof GitError && error.code !== "timeout" && !isGitProcessTreeTerminationFailure(error)) {
      return null;
    }
    throw error;
  }
}

/** Submodule paths from `.gitmodules` that resolve inside the checkout, at most `MAX_SUBMODULES`. */
async function submodulePaths(root: string, options: CheckoutFingerprintOptions): Promise<string[]> {
  let output: string;
  try {
    const result = await runGitInspection(
      root,
      ["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
      inspection(options, "Unable to read the submodule list.", MAX_GITMODULES_BYTES),
    );
    output = result.stdout.toString("utf8");
  } catch (error) {
    if (error instanceof GitError && error.code === "output-limit") throw new FingerprintLimit("The submodule list is too large.");
    if (error instanceof GitError && error.code !== "timeout" && !isGitProcessTreeTerminationFailure(error)) return [];
    throw error;
  }
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    const path = record.slice(record.indexOf("\n") + 1);
    if (!record.includes("\n") || path.length === 0) continue;
    const absolute = resolve(root, path);
    if (absolute !== root && isContained(root, absolute)) paths.add(path.replace(/\/+$/u, ""));
  }
  if (paths.size > MAX_SUBMODULES) throw new FingerprintLimit(`More than ${MAX_SUBMODULES} submodules.`);
  return [...paths];
}

/**
 * Folds each initialized submodule's own fingerprint into `entries`: its
 * dirty paths under the submodule's path, and its HEAD and branch on the
 * submodule's own entry. A submodule that resolves outside the checkout is
 * skipped.
 */
async function addSubmoduleEntries(
  root: string,
  entries: Map<string, string>,
  options: CheckoutFingerprintOptions,
  hashed: { bytes: number },
): Promise<void> {
  for (const path of await submodulePaths(root, options)) {
    const absolute = join(root, path);
    if (!await lstat(join(absolute, ".git")).catch(() => null)) continue;
    const canonical = await realpath(absolute).catch(() => null);
    if (canonical === null || canonical === root || !isContained(root, canonical)) continue;
    const submodule = await captureRepository(canonical, options, false, hashed);
    if (submodule.state === "truncated") throw new FingerprintLimit(submodule.reason);
    const own = entries.get(path) ?? "clean";
    if (submodule.state !== "captured" || submodule.root !== canonical) {
      entries.set(path, `${own}|unavailable`);
      continue;
    }
    entries.set(path, `${own}|${submodule.head ?? ""}@${submodule.branch ?? ""}`);
    for (const [child, descriptor] of submodule.entries) entries.set(`${path}/${child}`, descriptor);
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
  hashed: { bytes: number },
): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  const regular: string[] = [];
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
      hashed.bytes += info.size;
      if (hashed.bytes > MAX_CHECKOUT_FINGERPRINT_BYTES) throw new FingerprintLimit("The changed files are too large to fingerprint.");
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
  return await captureRepository(checkoutPath, options, true, { bytes: 0 });
}

async function captureRepository(
  checkoutPath: string,
  options: CheckoutFingerprintOptions,
  followSubmodules: boolean,
  hashed: { bytes: number },
): Promise<CheckoutFingerprint> {
  const pathOptions = { deadlineAt: options.deadlineAt, signal: options.signal };
  if (!await mayBeInsideGitRepository(checkoutPath, pathOptions)) {
    return { state: "unavailable", reason: "This checkout is not a Git repository." };
  }
  let root: string | null = null;
  try {
    root = await repositoryRoot(checkoutPath, pathOptions);
    const disabledFilterDrivers = await filterDriverNames(root, options);
    const head = await optionalLine(root, ["rev-parse", "--verify", "-q", "HEAD"], options);
    const branch = await optionalLine(root, ["symbolic-ref", "-q", "HEAD"], options);
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
    const digests = await worktreeDigests(root, entries, options, hashed);
    const fingerprint = new Map(entries.map((entry) => [
      entry.path,
      `${entry.descriptor}|${digests.get(entry.path) ?? "index"}`,
    ]));
    if (followSubmodules) await addSubmoduleEntries(root, fingerprint, options, hashed);
    if (fingerprint.size > MAX_CHECKOUT_FINGERPRINT_PATHS) {
      throw new FingerprintLimit(`More than ${MAX_CHECKOUT_FINGERPRINT_PATHS} paths changed.`);
    }
    return { state: "captured", root, head, branch, entries: fingerprint };
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
    headChanged: before.head !== after.head || before.branch !== after.branch,
    changedPaths: [...changed].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}
