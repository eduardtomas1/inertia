import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  resolve,
} from "node:path";

import {
  MAX_DIFF_BYTES,
  MAX_PATH_LENGTH,
} from "./constants";
import { isContained } from "./paths";
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
  root: string,
  path: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(path));
  } catch {
    throw new GitError(
      "conflict",
      "The selected file's parent folder is no longer available.",
    );
  }
  if (!isContained(root, canonicalParent)) {
    throw new GitError(
      "conflict",
      "The selected file's parent folder moved outside the repository.",
    );
  }
  const temporary = resolve(
    dirname(path),
    `.${basename(path)}.inertia-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", mode & 0o777);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, mode & 0o777);
    await rename(temporary, path);
    try {
      const directory = await open(dirname(path), fsConstants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Some platforms do not support syncing directory handles.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function fileStateMatches(
  root: string,
  absolute: string,
  path: string,
  worktreeOid: string,
  worktreeMode: number,
  indexOid: string,
  indexMode: string,
): Promise<boolean> {
  try {
    const [info, content, index] = await Promise.all([
      lstat(absolute),
      readFile(absolute),
      readIndexEntry(root, path),
    ]);
    return info.isFile()
      && !info.isSymbolicLink()
      && (info.mode & 0o777) === (worktreeMode & 0o777)
      && (await hashObject(root, content)) === worktreeOid
      && index.oid === indexOid
      && index.mode === indexMode;
  } catch {
    return false;
  }
}
