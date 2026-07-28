import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { gitProcessEnvironment } from "./git/environment";

export class CheckpointError extends Error {}

type RunResult = { stdout: Buffer; stderr: Buffer };

const MAX_CHECKPOINT_PATH_BYTES = 16 * 1024 * 1024;
const RAW_CHECKPOINT_ATTRIBUTES =
  "* -crlf -filter -ident -text -working-tree-encoding -eol\n";
const NUL_BYTE = Buffer.from([0]);

function parseTaggedCheckpointPaths(
  output: Buffer,
): { included: Buffer; skipped: Buffer } {
  const included: Buffer[] = [];
  const skipped: Buffer[] = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (
      end < 0
      || end - offset < 3
      || output[offset + 1] !== 0x20
    ) {
      throw new CheckpointError(
        "Git returned invalid checkpoint path data.",
      );
    }
    const target = output[offset] === 0x53 ? skipped : included;
    target.push(output.subarray(offset + 2, end), NUL_BYTE);
    offset = end + 1;
  }
  return {
    included: Buffer.concat(included),
    skipped: Buffer.concat(skipped),
  };
}

function runGit(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  input?: Buffer,
  acceptedExitCodes: readonly number[] = [0],
  maxStdoutBytes = 1024 * 1024,
): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: gitProcessEnvironment(environment),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLimitExceeded = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); rejectRun(new CheckpointError("Checkpoint operation timed out.")); }, 20_000);
    timer.unref();
    if (input && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxStdoutBytes) {
        stdoutLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      const part = chunk.subarray(0, maxStdoutBytes - stdoutBytes);
      stdout.push(part);
      stdoutBytes += part.length;
      if (part.length < chunk.length) {
        stdoutLimitExceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 16 * 1024) return;
      const part = chunk.subarray(0, 16 * 1024 - stderrBytes);
      stderr.push(part);
      stderrBytes += part.length;
    });
    child.once("error", () => { clearTimeout(timer); rejectRun(new CheckpointError("Git could not create the checkpoint.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (stdoutLimitExceeded) {
        rejectRun(new CheckpointError("The checkpoint contains too many file paths."));
      } else if (code !== null && acceptedExitCodes.includes(code)) resolveRun(result);
      else rejectRun(new CheckpointError(result.stderr.toString("utf8").toLowerCase().includes("not a git repository") ? "not-repository" : "Git could not create the checkpoint."));
    });
  });
}

function checkpointGitArguments(
  args: readonly string[],
): string[] {
  return [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    ...args,
  ];
}

async function checkpointEnvironment(
  repositoryPath: string,
  storageDirectory: string,
  checkpointId: string,
  environment: NodeJS.ProcessEnv,
): Promise<{
  environment: NodeJS.ProcessEnv;
  metadataDirectory: string;
  globalConfigPath: string;
  hooksDirectory: string;
}> {
  const metadataDirectory = resolve(
    storageDirectory,
    `${checkpointId}.git`,
  );
  const globalConfigPath = resolve(
    storageDirectory,
    `${checkpointId}.config`,
  );
  const hooksDirectory = resolve(
    metadataDirectory,
    "inertia-hooks",
  );
  const isolatedConfiguration: NodeJS.ProcessEnv = { ...environment };
  for (const name of Object.keys(isolatedConfiguration)) {
    if (
      name === "GIT_CONFIG_COUNT"
      || name === "GIT_CONFIG_PARAMETERS"
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)
    ) {
      delete isolatedConfiguration[name];
    }
  }
  isolatedConfiguration.GIT_CONFIG_NOSYSTEM = "1";
  isolatedConfiguration.GIT_CONFIG_GLOBAL = globalConfigPath;
  isolatedConfiguration.GIT_ATTR_NOSYSTEM = "1";
  await writeFile(globalConfigPath, "", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const objectFormat = (
    await runGit(
      repositoryPath,
      checkpointGitArguments(["rev-parse", "--show-object-format"]),
      isolatedConfiguration,
    )
  ).stdout.toString("utf8").trim();
  const objectDirectory = (
    await runGit(
      repositoryPath,
      checkpointGitArguments([
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ]),
      isolatedConfiguration,
    )
  ).stdout.toString("utf8").trim();
  if (
    (objectFormat !== "sha1" && objectFormat !== "sha256")
    || !objectDirectory
    || objectDirectory.includes("\0")
  ) {
    throw new CheckpointError(
      "Git could not isolate the checkpoint object store.",
    );
  }
  await runGit(
    storageDirectory,
    [
      "init",
      "--bare",
      "--quiet",
      ...(objectFormat === "sha256"
        ? ["--object-format=sha256"]
        : []),
      metadataDirectory,
    ],
    isolatedConfiguration,
  );
  await mkdir(hooksDirectory, { mode: 0o700 });
  await writeFile(
    resolve(metadataDirectory, "info", "attributes"),
    RAW_CHECKPOINT_ATTRIBUTES,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    metadataDirectory,
    globalConfigPath,
    hooksDirectory,
    environment: {
      ...isolatedConfiguration,
      GIT_DIR: metadataDirectory,
      GIT_WORK_TREE: resolve(repositoryPath),
      GIT_OBJECT_DIRECTORY: objectDirectory,
    },
  };
}

export async function createCheckpoint(repositoryPath: string, storageDirectory: string, conversationId: string): Promise<{ id: string; ref: string }> {
  const checkpointId = randomUUID();
  const ref = `refs/inertia/checkpoints/${conversationId}/${checkpointId}`;
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const indexPath = resolve(storageDirectory, `${checkpointId}.index`);
  const baseEnvironment = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "Inertia",
    GIT_AUTHOR_EMAIL: "checkpoint@inertia.local",
    GIT_COMMITTER_NAME: "Inertia",
    GIT_COMMITTER_EMAIL: "checkpoint@inertia.local",
  };
  let isolated: Awaited<ReturnType<typeof checkpointEnvironment>> | null = null;
  try {
    let head: string | null = null;
    try { head = (await runGit(repositoryPath, checkpointGitArguments(["rev-parse", "--verify", "HEAD"]))).stdout.toString("utf8").trim(); } catch { /* Repositories without a first commit are supported. */ }
    const taggedPaths = (
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-t",
          "-z",
        ]),
        process.env,
        undefined,
        [0],
        MAX_CHECKPOINT_PATH_BYTES,
      )
    ).stdout;
    const includedPaths =
      parseTaggedCheckpointPaths(taggedPaths).included;
    const indexEntries = (
      await runGit(
        repositoryPath,
        checkpointGitArguments(["ls-files", "--stage", "-z"]),
        process.env,
        undefined,
        [0],
        MAX_CHECKPOINT_PATH_BYTES,
      )
    ).stdout;
    isolated = await checkpointEnvironment(
      repositoryPath,
      storageDirectory,
      checkpointId,
      baseEnvironment,
    );
    const environment = isolated.environment;
    if (indexEntries.length > 0) {
      await runGit(
        repositoryPath,
        ["update-index", "-z", "--index-info"],
        environment,
        indexEntries,
      );
    } else {
      await runGit(
        repositoryPath,
        ["read-tree", "--empty"],
        environment,
      );
    }
    if (includedPaths.length > 0) {
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "--literal-pathspecs",
          "add",
          "-A",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ]),
        environment,
        includedPaths,
      );
    }
    const tree = (await runGit(repositoryPath, ["write-tree"], environment)).stdout.toString("utf8").trim();
    const commitArgs = ["commit-tree", tree, "-m", "Inertia checkpoint"];
    if (head) commitArgs.push("-p", head);
    const commit = (await runGit(repositoryPath, commitArgs, environment)).stdout.toString("utf8").trim();
    // The isolated metadata directory is temporary. Persist the checkpoint
    // reference through the real repository after the object is created.
    await runGit(
      repositoryPath,
      checkpointGitArguments([
        "-c",
        `core.hooksPath=${isolated.hooksDirectory}`,
        "update-ref",
        ref,
        commit,
      ]),
      baseEnvironment,
    );
    return { id: checkpointId, ref };
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
    await rm(`${indexPath}.lock`, { force: true }).catch(() => undefined);
    if (isolated) {
      await rm(isolated.metadataDirectory, {
        force: true,
        recursive: true,
      }).catch(() => undefined);
      await rm(isolated.globalConfigPath, { force: true })
        .catch(() => undefined);
    }
  }
}

export async function restoreCheckpoint(repositoryPath: string, ref: string, conversationId: string): Promise<void> {
  const prefix = `refs/inertia/checkpoints/${conversationId}/`;
  if (!ref.startsWith(prefix) || !/^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u.test(ref)) {
    throw new CheckpointError("The checkpoint reference is invalid.");
  }
  const restoreId = randomUUID();
  const restoreDirectory = await mkdtemp(
    join(tmpdir(), "inertia-checkpoint-restore-"),
  );
  const indexPath = resolve(restoreDirectory, `${restoreId}.index`);
  const baseEnvironment = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
  };
  try {
    const commit = (
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "rev-parse",
          "--verify",
          `${ref}^{commit}`,
        ]),
      )
    ).stdout.toString("utf8").trim();
    const indexEntries = (
      await runGit(
        repositoryPath,
        checkpointGitArguments(["ls-files", "--stage", "-z"]),
        process.env,
        undefined,
        [0],
        MAX_CHECKPOINT_PATH_BYTES,
      )
    ).stdout;
    const taggedPaths = (
      await runGit(
        repositoryPath,
        checkpointGitArguments(["ls-files", "--cached", "-t", "-z"]),
        process.env,
        undefined,
        [0],
        MAX_CHECKPOINT_PATH_BYTES,
      )
    ).stdout;
    const skippedPaths =
      parseTaggedCheckpointPaths(taggedPaths).skipped;
    const isolated = await checkpointEnvironment(
      repositoryPath,
      restoreDirectory,
      restoreId,
      baseEnvironment,
    );
    await runGit(
      repositoryPath,
      ["read-tree", "--empty"],
      isolated.environment,
    );
    if (indexEntries.length > 0) {
      await runGit(
        repositoryPath,
        ["update-index", "-z", "--index-info"],
        isolated.environment,
        indexEntries,
      );
    }
    if (skippedPaths.length > 0) {
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "--literal-pathspecs",
          "update-index",
          "--skip-worktree",
          "-z",
          "--stdin",
        ]),
        isolated.environment,
        skippedPaths,
      );
    }
    await runGit(
      repositoryPath,
      checkpointGitArguments([
        "restore",
        "--source",
        commit,
        "--worktree",
        "--",
        ".",
      ]),
      isolated.environment,
    );
  } finally {
    await rm(restoreDirectory, {
      force: true,
      recursive: true,
    }).catch(() => undefined);
  }
}

export async function deleteCheckpoints(repositoryPath: string, conversationId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/u.test(conversationId)) throw new CheckpointError("The checkpoint namespace is invalid.");
  const prefix = `refs/inertia/checkpoints/${conversationId}/`;
  const refs = (await runGit(repositoryPath, ["for-each-ref", "--format=%(refname)", prefix])).stdout.toString("utf8").split("\n").map((ref) => ref.trim()).filter((ref) => ref.startsWith(prefix));
  if (refs.length === 0) return;
  const hooksDirectory = await mkdtemp(
    join(tmpdir(), "inertia-checkpoint-hooks-"),
  );
  try {
    await Promise.all(
      refs.map((ref) => runGit(
        repositoryPath,
        checkpointGitArguments([
          "-c",
          `core.hooksPath=${hooksDirectory}`,
          "update-ref",
          "-d",
          ref,
        ]),
      )),
    );
  } finally {
    await rm(hooksDirectory, {
      force: true,
      recursive: true,
    }).catch(() => undefined);
  }
}
