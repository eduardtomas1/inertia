import {
  repositoryRoot,
  validateBranch,
  validateName,
  type GitPathInspectionOptions,
} from "./paths";
import { runGit, runGitInspection } from "./runner";
import { getRepositoryStatus } from "./status";
import { requireUnambiguousBranchTracking } from "./branch-tracking";
import {
  GitError,
  type GitBranch,
  type GitBranches,
  type GitMutationResult,
} from "./types";

function parseBranches(buffer: Buffer): GitBranch[] {
  return buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", commit = "", upstream = "", head = "", occupied = "", symbolic = ""] =
        line.split("\0");
      const kind: GitBranch["kind"] = ref.startsWith("refs/heads/") ? "local" : "remote";
      return {
        name: symbolic ? "" : ref.slice(kind === "local" ? 11 : 13),
        kind,
        current: head === "*",
        commit,
        upstream: upstream || null,
        checkedOut: occupied === "occupied",
      };
    })
    .filter(
      (branch) =>
        branch.name.length > 0,
    );
}

export async function listBranches(
  repositoryPath: string,
  options: GitPathInspectionOptions = {},
): Promise<GitBranches> {
  options = { ...options, deadlineAt: options.deadlineAt ?? Date.now() + 120_000 };
  const root = await repositoryRoot(repositoryPath, options);
  const format =
    "%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(if)%(worktreepath)%(then)occupied%(end)%00%(symref)";
  const args = [
    `--format=${format}`,
    "--sort=refname",
    "refs/heads",
    "refs/remotes",
  ];
  const inspection = {
    ...options,
    maxOutputBytes: 1024 * 1024,
    failureMessage: "Unable to list repository branches.",
  };
  const result = await runGitInspection(root, ["for-each-ref", "--count=1001", ...args], inspection);
  let branches = parseBranches(result.stdout);
  if (branches.length <= 1000 && result.stdout.toString("utf8").split("\n").filter(Boolean).length > 1000) {
    // Symbolic aliases can consume the raw sentinel. Read all refs under the
    // same output/deadline limits so aliases cannot hide selectable overflow.
    const complete = await runGitInspection(root, ["for-each-ref", ...args], inspection);
    branches = parseBranches(complete.stdout);
  }
  if (branches.length > 1000) {
    throw new GitError("output-limit", "This repository has more than 1,000 branches. Use the terminal to select a branch.");
  }
  const local = branches.filter((branch) => branch.kind === "local");
  const remote = branches.filter((branch) => branch.kind === "remote");
  return {
    current: local.find((branch) => branch.current)?.name ?? null,
    local,
    remote,
  };
}

export async function switchBranch(
  repositoryPath: string,
  branch: string,
  options: GitPathInspectionOptions & { remote?: boolean } = {},
): Promise<GitMutationResult> {
  options = { ...options, deadlineAt: options.deadlineAt ?? Date.now() + 120_000 };
  const root = await repositoryRoot(repositoryPath, options);
  const name = await validateBranch(root, branch, options);
  const branches = await listBranches(root, options);
  const target = (options.remote ? branches.remote : branches.local)
    .find((candidate) => candidate.name === name);
  if (!target) throw new GitError("not-found", "This branch no longer exists. Refresh branches and try again.");
  if (target.current) return { status: await getRepositoryStatus(root, options) };
  if (target.checkedOut) throw new GitError("conflict", "This branch is checked out in another worktree. Open that worktree to use it.");
  const status = await getRepositoryStatus(root, options);
  requireCleanCheckout(status, "switching branches");
  let args = ["switch", "--no-guess", "--", name];
  if (options.remote) {
    const remotes = await runGitInspection(root, ["remote"], {
      ...options,
      maxOutputBytes: 16 * 1024,
      failureMessage: "Unable to inspect repository remotes.",
    });
    const remote = remotes.stdout.toString("utf8").split("\n")
      .filter((candidate) => candidate && name.startsWith(`${candidate}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (!remote) throw new GitError("not-found", "The remote for this branch no longer exists. Fetch and try again.");
    const localName = await validateBranch(root, name.slice(remote.length + 1), options);
    if (branches.local.some((candidate) => candidate.name === localName)) {
      throw new GitError("conflict", "A local branch with this name already exists. Select it in Local branches.");
    }
    const fallback = await requireUnambiguousBranchTracking(root, remote, name, options);
    if (fallback) {
      await runGit(root, ["config", "--local", "--add", `remote.${remote}.fetch`, fallback], {
        ...options, failureMessage: "Unable to configure remote branch tracking. Check the repository config lock, then retry.",
      });
      await requireUnambiguousBranchTracking(root, remote, name, options);
    }
    args = ["switch", "--track", "-c", localName, `refs/remotes/${name}`];
  }
  await runGit(root, args, {
    ...options,
    failureMessage: "Unable to switch branches.",
  });
  return { status: await getRepositoryStatus(root, options) };
}

export function requireCleanCheckout(
  status: Awaited<ReturnType<typeof getRepositoryStatus>>,
  action: string,
): void {
  if (status.truncated) throw new GitError("output-limit", `The complete repository status is unavailable. Refresh before ${action}.`);
  if (!status.clean) throw new GitError("conflict", `Commit or stash local changes before ${action}.`);
}

export async function createBranch(
  repositoryPath: string,
  branch: string,
  startPoint?: string,
): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  const name = await validateBranch(root, branch);
  const args = ["switch", "-c", name];
  if (startPoint !== undefined) {
    args.push(validateName(startPoint, "The starting revision"));
  }
  await runGit(root, args, {
    failureMessage: "Unable to create the branch.",
  });
  return { status: await getRepositoryStatus(root) };
}

async function localBranchHead(
  root: string,
  branch: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const result = await runGit(
    root,
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      ref,
    ],
    { failureMessage: "Unable to inspect the local branch." },
  );
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [candidate = "", head = ""] = line.split("\0");
    if (candidate === ref) return head || null;
  }
  return null;
}

export type BranchCleanupOutcome = "absent" | "retained";

export async function inspectBranchCleanupOutcome(
  repositoryPath: string,
  branch: string,
  expectedHead: string,
): Promise<BranchCleanupOutcome> {
  const root = await repositoryRoot(repositoryPath);
  const name = await validateBranch(root, branch);
  if (!/^[0-9a-f]{40,64}$/u.test(expectedHead)) {
    throw new GitError(
      "invalid-input",
      "The expected branch identity is invalid.",
    );
  }
  const currentHead = await localBranchHead(root, name);
  return currentHead === null ? "absent" : "retained";
}
