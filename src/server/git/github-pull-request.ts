import { repositoryRoot } from "./paths";
import { inspectGitRemoteRouting } from "./remote-routing";
import { getRepositoryStatus } from "./status";
import { GitError } from "./types";
import {
  executableCandidates,
  providerEnvironment,
  type ProviderEnvironment,
} from "../environment";
import {
  RestrictedCliError,
  runRestrictedCli,
  type RestrictedCliDependencies,
} from "../restricted-cli-runner";

const MAX_PULL_REQUEST_BODY_BYTES = 64 * 1024;

export interface GitHubPullRequestDependencies extends RestrictedCliDependencies {
  environment?: () => Promise<ProviderEnvironment>;
  executableCandidates?: typeof executableCandidates;
}

export interface GitHubPullRequestInput {
  title: string;
  body: string;
  draft: boolean;
}

export function githubRepositorySlug(repositoryBaseUrl: string): string {
  const url = new URL(repositoryBaseUrl);
  const slug = url.pathname.replace(/^\/+|\/+$/gu, "");
  if (url.hostname !== "github.com" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug)) {
    throw new GitError("invalid-input", "The selected GitHub repository is invalid.");
  }
  return slug;
}

export function verifiedGitHubPullRequestUrl(
  value: string,
  repositoryBaseUrl: string,
): string | null {
  const match = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*/gu.exec(value);
  if (!match) return null;
  const url = new URL(match[0]);
  const repository = new URL(repositoryBaseUrl);
  return url.origin === repository.origin
    && url.pathname.toLowerCase().startsWith(
      `${repository.pathname.toLowerCase()}/pull/`,
    )
    ? url.toString()
    : null;
}

export async function resolveGitHubCli(
  dependencies: GitHubPullRequestDependencies = {},
): Promise<{ executable: string; environment: NodeJS.ProcessEnv }> {
  const environment = await (dependencies.environment ?? providerEnvironment)();
  const candidates = await (
    dependencies.executableCandidates ?? executableCandidates
  )("gh", environment);
  const executable = candidates[0];
  if (!executable) {
    throw new RestrictedCliError(
      "unavailable",
      "gh is not installed or could not be started.",
    );
  }
  return { executable, environment: environment.env };
}

export async function createGitHubPullRequest(
  repositoryPath: string,
  input: GitHubPullRequestInput,
  dependencies: GitHubPullRequestDependencies = {},
): Promise<string> {
  const root = await repositoryRoot(repositoryPath);
  const status = await getRepositoryStatus(root);
  if (!status.branch) {
    throw new GitError(
      "invalid-input",
      "Check out a branch before creating a pull request.",
    );
  }
  const routing = await inspectGitRemoteRouting(root, status.branch);
  if (!routing.target || routing.target.forge !== "github") {
    throw new GitError(
      "operation-failed",
      "Integrated pull request creation is available for GitHub repositories. Use the browser flow for this remote.",
    );
  }
  if (Buffer.byteLength(input.body, "utf8") > MAX_PULL_REQUEST_BODY_BYTES) {
    throw new GitError("invalid-input", "The pull request description is too large.");
  }
  const repositorySlug = githubRepositorySlug(routing.target.baseUrl);
  try {
    const gh = await resolveGitHubCli(dependencies);
    const result = await runRestrictedCli(
      gh.executable,
      [
        "pr", "create", "--repo", repositorySlug, "--title", input.title,
        "--body-file", "-", "--head", status.branch,
        ...(input.draft ? ["--draft"] : []),
      ],
      {
        cwd: root,
        environment: gh.environment,
        input: input.body,
        failureMessage: "GitHub could not create the pull request. Confirm the branch is pushed and GitHub CLI is signed in.",
      },
      dependencies,
    );
    const url = verifiedGitHubPullRequestUrl(
      `${result.stdout}\n${result.stderr}`,
      routing.target.baseUrl,
    );
    if (!url) {
      throw new GitError(
        "operation-failed",
        "GitHub created no verifiable pull request URL.",
      );
    }
    return url;
  } catch (error) {
    if (error instanceof GitError) throw error;
    if (error instanceof RestrictedCliError && error.code === "unavailable") {
      throw new GitError(
        "operation-failed",
        "GitHub CLI is not installed. Install and sign in to gh, or use the browser pull request flow.",
      );
    }
    throw new GitError(
      "operation-failed",
      error instanceof Error
        ? error.message
        : "GitHub could not create the pull request.",
    );
  }
}
