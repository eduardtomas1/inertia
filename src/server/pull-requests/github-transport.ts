import { resolveGitHubCli, type GitHubPullRequestDependencies } from "../git/github-pull-request";
import { RestrictedCliError, runRestrictedCli } from "../restricted-cli-runner";
import { RuntimeRequestError } from "../runtime-errors";

export class GitHubResponseError extends RuntimeRequestError {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? "GitHub access was refused. Check the signed-in gh account and repository permissions."
      : status === 404 ? "GitHub could not find this pull request or stack for the signed-in account."
        : "GitHub could not complete this request. Refresh to check its status.");
  }
}
export type GitHubRequest = (method: "GET" | "POST" | "PUT", endpoint: string, body?: Record<string, unknown>) => Promise<unknown>;

/** No arbitrary host, shell, token environment or local-repository inference. */
export function createGitHubRequest(cwd: string, signal: AbortSignal, dependencies: GitHubPullRequestDependencies = {}): GitHubRequest {
  return async (method, endpoint, body) => {
    if (endpoint !== "graphql" && !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:stacks(?:\?pull_request=[1-9][0-9]*|\/[1-9][0-9]*)|pulls\/[1-9][0-9]*\/merge-async(?:\/[A-Za-z0-9_-]+)?)$/u.test(endpoint)) {
      throw new RuntimeRequestError("The GitHub request endpoint is invalid.");
    }
    try {
    const gh = await resolveGitHubCli(dependencies, { signal });
    const result = await runRestrictedCli(gh.executable,
      ["api", "--hostname", "github.com", "--include", "--method", method, endpoint,
        ...(body ? ["--input", "-"] : [])],
      { cwd, environment: gh.environment, signal, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
        input: body ? JSON.stringify(body) : undefined, acceptedExitCodes: [1],
        failureMessage: "GitHub did not return a response. Refresh to check the outcome." }, dependencies);
    return decodeGitHubResponse(result.stdout, result.exitCode ?? 0);
    } catch (error) {
      if (error instanceof RestrictedCliError) throw new RuntimeRequestError(error.code === "unavailable"
        ? "GitHub CLI is unavailable. Install gh and sign in to use pull requests."
        : "GitHub CLI did not complete this request. Check its status and refresh.");
      throw error;
    }
  };
}
export function decodeGitHubResponse(stdout: string, exitCode: number): unknown {
  const match = /^HTTP\/[0-9.]+ ([0-9]{3})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*)$/u.exec(stdout);
  if (!match) throw new RuntimeRequestError("GitHub returned an unreadable response.");
  const status = Number(match[1]);
  if (status < 200 || status >= 300) throw new GitHubResponseError(status);
  if (exitCode !== 0) throw new RuntimeRequestError("GitHub did not confirm this request.");
  try { return JSON.parse(match[2]!); }
  catch { throw new RuntimeRequestError("GitHub returned invalid JSON."); }
}
