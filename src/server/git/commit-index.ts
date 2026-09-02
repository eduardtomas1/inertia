import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { open } from "node:fs/promises";

import { FILE_OPEN_NO_FOLLOW } from
  "../../node/platform-file-open-flags";
import { runGit } from "./runner";
import { GitError } from "./types";

const MAX_INDEX_BYTES = 256 * 1024 * 1024;

function nulPaths(paths: readonly string[]): Buffer {
  return Buffer.concat(paths.flatMap((path) => [
    Buffer.from(path),
    Buffer.from([0]),
  ]));
}

function tempIndexArguments(args: readonly string[]): string[] {
  return ["--no-pager", "-c", "core.fsmonitor=false", ...args];
}

async function readIndex(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_INDEX_BYTES) {
      throw new GitError(
        "output-limit",
        "The repository index is unavailable for an atomic reviewed commit.",
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function readIndexSync(path: string): Buffer {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW,
    );
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return Buffer.alloc(0);
    throw error;
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_INDEX_BYTES) {
      throw new GitError(
        "output-limit",
        "The repository index is unavailable for an atomic reviewed commit.",
      );
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function prepareReconciledIndex(
  root: string,
  original: Buffer,
  selectedTree: string,
  selectedPaths: readonly string[],
  directory: string,
  deadlineAt?: number,
): Promise<Buffer> {
  const preparedPath = `${directory}/reconciled.index`;
  const environment = { GIT_INDEX_FILE: preparedPath };
  if (original.length > 0) {
    const handle = await open(preparedPath, "wx", 0o600);
    try {
      await handle.writeFile(original);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await runGit(root, tempIndexArguments(["read-tree", "--empty"]), {
      deadlineAt,
      environment,
      maxOutputBytes: 1_024,
      failureMessage: "Unable to prepare the reconciled repository index.",
    });
  }
  await runGit(root, tempIndexArguments([
    "reset",
    selectedTree,
    "--pathspec-from-file=-",
    "--pathspec-file-nul",
  ]), {
    deadlineAt,
    environment,
    input: nulPaths(selectedPaths),
    maxOutputBytes: 1_024,
    failureMessage: "Unable to prepare the reconciled repository index.",
  });
  return await readIndex(preparedPath);
}
