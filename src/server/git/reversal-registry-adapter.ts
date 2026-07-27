import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { sha256 } from "../../shared/diff-review";
import {
  ReversalRegistryController,
  ReversalRegistryError,
  REVERSAL_MAX_ACTIVE_BACKUPS,
  type ReversalCheckoutIdentity,
  type ReversalRegistryStorage,
  type ReversalRepositoryIdentity,
} from "../reversal-registry";
import {
  MAX_DIFF_BYTES,
  MAX_PATH_LENGTH,
} from "./constants";
import {
  repositoryRoot,
  validatedPaths,
} from "./paths";
import {
  fileStateMatches,
  hashObject,
} from "./reversal-files";
import { runGit } from "./runner";
import { GitError } from "./types";

async function resolveRef(
  root: string,
  ref: string,
): Promise<string | null> {
  try {
    const result = await runGit(
      root,
      ["rev-parse", "--verify", "--end-of-options", ref],
      {
        maxOutputBytes: 256,
        failureMessage: "Unable to inspect the selective-reversal registry.",
      },
    );
    const oid = result.stdout.toString("utf8").trim();
    return /^[0-9a-f]{40,64}$/u.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

function reversalRegistryStorage(root: string): ReversalRegistryStorage {
  const compareAndSwapRef = async (
    ref: string,
    nextOid: string,
    expectedOid: string | null,
  ): Promise<boolean> => {
    try {
      await runGit(
        root,
        [
          "update-ref",
          ref,
          nextOid,
          expectedOid ?? "0".repeat(nextOid.length),
        ],
        {
          maxOutputBytes: 256,
          failureMessage: "Unable to update the selective-reversal registry.",
        },
      );
      return true;
    } catch (error) {
      if ((await resolveRef(root, ref)) !== expectedOid) return false;
      throw error;
    }
  };
  return {
    async readRef(ref) {
      const oid = await resolveRef(root, ref);
      if (!oid) return null;
      const sizeResult = await runGit(root, ["cat-file", "-s", oid], {
        maxOutputBytes: 64,
        failureMessage:
          "Unable to inspect the selective-reversal registry or backup.",
      });
      const size = Number(sizeResult.stdout.toString("utf8").trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new GitError(
          "operation-failed",
          "Git returned an invalid selective-reversal object size.",
        );
      }
      if (size > MAX_DIFF_BYTES) return { oid, content: Buffer.alloc(0) };
      const content = await runGit(root, ["cat-file", "blob", oid], {
        maxOutputBytes: MAX_DIFF_BYTES,
        failureMessage:
          "Unable to read the selective-reversal registry or backup.",
      });
      return { oid, content: content.stdout };
    },
    writeBlob: (content) => hashObject(root, content),
    compareAndSwapRef,
    createRef: (ref, oid) => compareAndSwapRef(ref, oid, null),
    async deleteRef(ref, expectedOid) {
      const current = await resolveRef(root, ref);
      if (!current) return true;
      if (current !== expectedOid) return false;
      try {
        await runGit(root, ["update-ref", "-d", ref, expectedOid], {
          maxOutputBytes: 256,
          failureMessage: "Unable to clean up a selective-reversal backup.",
        });
        return true;
      } catch (error) {
        const after = await resolveRef(root, ref);
        if (!after) return true;
        if (after !== expectedOid) return false;
        throw error;
      }
    },
  };
}

async function canonicalGitPath(
  root: string,
  argument: "--git-common-dir" | "--git-dir",
): Promise<string> {
  const result = await runGit(root, ["rev-parse", argument], {
    maxOutputBytes: MAX_PATH_LENGTH,
    failureMessage: "Unable to identify this Git repository checkout.",
  });
  const reported = result.stdout.toString("utf8").trim();
  try {
    return await realpath(
      isAbsolute(reported) ? reported : resolve(root, reported),
    );
  } catch {
    throw new GitError(
      "conflict",
      "This Git repository checkout identity could not be verified.",
    );
  }
}

async function reversalIdentities(root: string): Promise<{
  repository: ReversalRepositoryIdentity;
  checkout: ReversalCheckoutIdentity;
}> {
  const [commonDirectory, gitDirectory, rootInfo] = await Promise.all([
    canonicalGitPath(root, "--git-common-dir"),
    canonicalGitPath(root, "--git-dir"),
    stat(root),
  ]);
  const [commonInfo, gitInfo] = await Promise.all([
    stat(commonDirectory),
    stat(gitDirectory),
  ]);
  const repositoryFingerprint = sha256([
    commonDirectory,
    String(commonInfo.dev),
    String(commonInfo.ino),
  ].join("\0"));
  const checkoutFingerprint = sha256([
    root,
    String(rootInfo.dev),
    String(rootInfo.ino),
    gitDirectory,
    String(gitInfo.dev),
    String(gitInfo.ino),
  ].join("\0"));
  return {
    repository: {
      commonDirectory,
      fingerprint: repositoryFingerprint,
    },
    checkout: {
      rootDirectory: root,
      gitDirectory,
      fingerprint: checkoutFingerprint,
    },
  };
}

function registryError(error: unknown): never {
  if (!(error instanceof ReversalRegistryError)) throw error;
  if (error.kind === "invalid") {
    throw new GitError("invalid-input", error.message);
  }
  if (error.kind === "not-found" || error.kind === "incompatible") {
    throw new GitError("not-found", error.message);
  }
  throw new GitError("conflict", error.message);
}

export async function reversalController(
  root: string,
): Promise<ReversalRegistryController> {
  const identities = await reversalIdentities(root);
  return new ReversalRegistryController(
    reversalRegistryStorage(root),
    identities.repository,
    identities.checkout,
  );
}

export async function registryOperation<T>(
  operation: Promise<T>,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    registryError(error);
  }
}

export async function maintainReversalOperations(
  root: string,
  controller: ReversalRegistryController,
  maxActiveBackups = REVERSAL_MAX_ACTIVE_BACKUPS,
): Promise<void> {
  await registryOperation(controller.cleanup(maxActiveBackups));
  const operations = await registryOperation(controller.operations());
  for (const operation of operations) {
    if (operation.status !== "applying" && operation.status !== "undoing") {
      continue;
    }
    try {
      controller.assertCurrentIdentity(operation);
    } catch {
      continue;
    }
    let path: string;
    try {
      [path] = await validatedPaths(root, [operation.filePath]) as [string];
    } catch {
      await registryOperation(
        controller.markRecoveryRequired(operation.operationId),
      );
      continue;
    }
    const absolute = resolve(root, path);
    const [matchesPreState, matchesPostState] = await Promise.all([
      fileStateMatches(
        root,
        absolute,
        path,
        operation.preWorktreeOid,
        operation.preWorktreeMode,
        operation.preIndexOid,
        operation.preIndexMode,
      ),
      fileStateMatches(
        root,
        absolute,
        path,
        operation.postWorktreeOid,
        operation.postWorktreeMode,
        operation.postIndexOid,
        operation.postIndexMode,
      ),
    ]);
    if (operation.status === "applying" && matchesPostState) {
      await registryOperation(
        controller.markApplied(operation.operationId),
      );
    } else if (operation.status === "applying" && matchesPreState) {
      const failed = await registryOperation(
        controller.markFailed(operation.operationId),
      );
      await registryOperation(controller.deleteBackups(failed));
    } else if (operation.status === "undoing" && matchesPreState) {
      const undone = await registryOperation(
        controller.markUndone(operation.operationId),
      );
      await registryOperation(controller.deleteBackups(undone));
    } else if (operation.status === "undoing" && matchesPostState) {
      await registryOperation(
        controller.markApplied(operation.operationId),
      );
    } else {
      await registryOperation(
        controller.markRecoveryRequired(operation.operationId),
      );
    }
  }
  await registryOperation(controller.cleanup(maxActiveBackups));
}

export async function cleanupReversalOperations(
  repositoryPath: string,
): Promise<void> {
  const root = await repositoryRoot(repositoryPath);
  const controller = await reversalController(root);
  await maintainReversalOperations(root, controller);
}
