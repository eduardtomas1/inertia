import { createHash } from "node:crypto";

import {
  MAX_DIFF_BYTES,
  MAX_PATH_LENGTH,
} from "./constants";
import {
  SecureFileError,
  type RuntimeSecureFileBroker,
  type SecureFileRootCapability,
} from "../secure-files";
import { runGit } from "./runner";
import { GitError } from "./types";

export interface IndexEntry {
  mode: string;
  oid: string;
  content: Buffer;
}

export function bufferHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function textBuffer(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new GitError(
      "invalid-input",
      "Selective reversal supports UTF-8 text files only.",
    );
  }
}

export async function readIndexEntry(
  root: string,
  path: string,
): Promise<IndexEntry> {
  const listed = await runGit(root, ["ls-files", "--stage", "-z", "--", path], {
    maxOutputBytes: MAX_PATH_LENGTH + 256,
    failureMessage: "Unable to inspect the selected file in the Git index.",
  });
  const records = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  if (records.length !== 1) {
    throw new GitError(
      "conflict",
      "The selected file does not have one resolved Git index entry.",
    );
  }
  const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/u.exec(
    records[0]!,
  );
  if (!match || match[3] !== path) {
    throw new GitError(
      "conflict",
      "The selected file has an unsupported or unresolved Git index state.",
    );
  }
  const content = await runGit(root, ["cat-file", "blob", match[2]!], {
    maxOutputBytes: MAX_DIFF_BYTES,
    failureMessage: "Unable to read the selected staged file.",
  });
  return { mode: match[1]!, oid: match[2]!, content: content.stdout };
}

export async function hashObject(
  root: string,
  content: Buffer,
): Promise<string> {
  const result = await runGit(root, ["hash-object", "-w", "--stdin"], {
    input: content,
    maxOutputBytes: 256,
    failureMessage: "Unable to create a reversible Git backup.",
  });
  const oid = result.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
    throw new GitError(
      "operation-failed",
      "Git returned an invalid backup object.",
    );
  }
  return oid;
}

export async function updateIndexEntry(
  root: string,
  path: string,
  mode: string,
  oid: string,
): Promise<void> {
  await runGit(root, ["update-index", "--cacheinfo", mode, oid, path], {
    maxOutputBytes: 256,
    failureMessage: "Unable to update the selected file in the Git index.",
  });
}

export async function writeAtomic(
  _root: string,
  path: string,
  content: Buffer,
  mode: number,
  expectedContent: Buffer,
  secureFiles: RuntimeSecureFileBroker,
  secureRoot: SecureFileRootCapability,
  testHooks?: {
    afterTargetOpened?: () => void | Promise<void>;
  },
): Promise<void> {
  const expectedDigest = bufferHash(expectedContent);
  const desiredDigest = bufferHash(content);
  try {
    const before = await secureFiles.read(
      secureRoot,
      path,
      MAX_DIFF_BYTES,
    );
    if (before.digest !== expectedDigest) {
      throw new GitError(
        "conflict",
        "The selected file changed before it could be updated.",
      );
    }
    await testHooks?.afterTargetOpened?.();
    const replaced = await secureFiles.replace(
      secureRoot,
      path,
      content,
      before.digest,
      before.mode,
      mode,
      MAX_DIFF_BYTES,
    );
    if (replaced.digest !== desiredDigest) {
      throw new GitError(
        "conflict",
        "The selected file could not be verified after it was updated.",
      );
    }
  } catch (error) {
    if (error instanceof GitError) throw error;
    if (error instanceof SecureFileError) {
      const current = await secureFiles.read(
        secureRoot,
        path,
        MAX_DIFF_BYTES,
      ).catch(() => null);
      if (current?.digest === desiredDigest) return;
      if (current?.digest !== expectedDigest) {
        throw new GitError(
          "conflict",
          "The file update outcome could not be verified safely.",
        );
      }
      throw new GitError(
        error.code === "too-large" ? "output-limit" : "conflict",
        error.message,
      );
    }
    throw error;
  }
}

export async function fileStateMatches(
  root: string,
  path: string,
  worktreeOid: string,
  worktreeMode: number,
  indexOid: string,
  indexMode: string,
  secureFiles: RuntimeSecureFileBroker,
  secureRoot: SecureFileRootCapability,
): Promise<boolean> {
  try {
    const [worktree, index] = await Promise.all([
      secureFiles.read(secureRoot, path, MAX_DIFF_BYTES),
      readIndexEntry(root, path),
    ]);
    return (worktree.mode & 0o777) === (worktreeMode & 0o777)
      && (await hashObject(root, worktree.content)) === worktreeOid
      && index.oid === indexOid
      && index.mode === indexMode;
  } catch {
    return false;
  }
}
