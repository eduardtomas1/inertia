import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class CheckpointError extends Error {}

type RunResult = { stdout: string; stderr: string };

function runGit(cwd: string, args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...environment, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); rejectRun(new CheckpointError("Checkpoint operation timed out.")); }, 20_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(0, 1024 * 1024); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 16 * 1024); });
    child.once("error", () => { clearTimeout(timer); rejectRun(new CheckpointError("Git could not create the checkpoint.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new CheckpointError(stderr.toLowerCase().includes("not a git repository") ? "not-repository" : "Git could not create the checkpoint."));
    });
  });
}

export async function createCheckpoint(repositoryPath: string, storageDirectory: string, conversationId: string): Promise<{ id: string; ref: string }> {
  const checkpointId = randomUUID();
  const ref = `refs/inertia/checkpoints/${conversationId}/${checkpointId}`;
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const indexPath = resolve(storageDirectory, `${checkpointId}.index`);
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "Inertia",
    GIT_AUTHOR_EMAIL: "checkpoint@inertia.local",
    GIT_COMMITTER_NAME: "Inertia",
    GIT_COMMITTER_EMAIL: "checkpoint@inertia.local",
  };
  try {
    let head: string | null = null;
    try { head = (await runGit(repositoryPath, ["rev-parse", "--verify", "HEAD"])).stdout.trim(); } catch { /* Repositories without a first commit are supported. */ }
    await runGit(repositoryPath, head ? ["read-tree", head] : ["read-tree", "--empty"], environment);
    await runGit(repositoryPath, ["add", "-A", "--", "."], environment);
    const tree = (await runGit(repositoryPath, ["write-tree"], environment)).stdout.trim();
    const commitArgs = ["commit-tree", tree, "-m", "Inertia checkpoint"];
    if (head) commitArgs.push("-p", head);
    const commit = (await runGit(repositoryPath, commitArgs, environment)).stdout.trim();
    await runGit(repositoryPath, ["update-ref", ref, commit]);
    return { id: checkpointId, ref };
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
    await rm(`${indexPath}.lock`, { force: true }).catch(() => undefined);
  }
}

export async function restoreCheckpoint(repositoryPath: string, ref: string, conversationId: string): Promise<void> {
  const prefix = `refs/inertia/checkpoints/${conversationId}/`;
  if (!ref.startsWith(prefix) || !/^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u.test(ref)) {
    throw new CheckpointError("The checkpoint reference is invalid.");
  }
  await runGit(repositoryPath, ["rev-parse", "--verify", ref]);
  await runGit(repositoryPath, ["restore", "--source", ref, "--worktree", "--", "."]);
}

export async function deleteCheckpoints(repositoryPath: string, conversationId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/u.test(conversationId)) throw new CheckpointError("The checkpoint namespace is invalid.");
  const prefix = `refs/inertia/checkpoints/${conversationId}/`;
  const refs = (await runGit(repositoryPath, ["for-each-ref", "--format=%(refname)", prefix])).stdout.split("\n").map((ref) => ref.trim()).filter((ref) => ref.startsWith(prefix));
  await Promise.all(refs.map((ref) => runGit(repositoryPath, ["update-ref", "-d", ref])));
}
