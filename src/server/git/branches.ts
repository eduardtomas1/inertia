import {
  repositoryRoot,
  validateBranch,
  validateName,
} from "./paths";
import { runGit } from "./runner";
import { getRepositoryStatus } from "./status";
import type {
  GitBranch,
  GitBranches,
  GitMutationResult,
} from "./types";

function parseBranches(buffer: Buffer, kind: GitBranch["kind"]): GitBranch[] {
  return buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", commit = "", upstream = "", head = ""] =
        line.split("\0");
      return {
        name,
        kind,
        current: head === "*",
        commit,
        upstream: upstream || null,
      };
    })
    .filter(
      (branch) =>
        branch.name.length > 0 && !branch.name.endsWith("/HEAD"),
    );
}

export async function listBranches(
  repositoryPath: string,
): Promise<GitBranches> {
  const root = await repositoryRoot(repositoryPath);
  const format =
    "%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)";
  const [localResult, remoteResult] = await Promise.all([
    runGit(
      root,
      [
        "for-each-ref",
        `--format=${format}`,
        "--sort=refname",
        "refs/heads",
      ],
      { failureMessage: "Unable to list local branches." },
    ),
    runGit(
      root,
      [
        "for-each-ref",
        `--format=${format}`,
        "--sort=refname",
        "refs/remotes",
      ],
      { failureMessage: "Unable to list remote branches." },
    ),
  ]);
  const local = parseBranches(localResult.stdout, "local");
  const remote = parseBranches(remoteResult.stdout, "remote");
  return {
    current: local.find((branch) => branch.current)?.name ?? null,
    local,
    remote,
  };
}

export async function switchBranch(
  repositoryPath: string,
  branch: string,
): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  const name = await validateBranch(root, branch);
  await runGit(root, ["switch", "--", name], {
    failureMessage: "Unable to switch branches.",
  });
  return { status: await getRepositoryStatus(root) };
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
