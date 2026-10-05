import { ISSUE_GITHUB_STATES, ISSUE_REPOSITORY, REPORT_BODY_LIMIT, type IssueGitHubState, type IssuePublicationFailure } from "../../shared/issue-report";
import { resolveGitHubCli, type GitHubPullRequestDependencies } from "./github-pull-request";
import { RestrictedCliError, runRestrictedCli } from "../restricted-cli-runner";

export interface IssuePublisher {
  status(): Promise<IssueGitHubState>;
  create(input: { id: string; title: string; body: string; beforePublish(): void }): Promise<string>;
  find(id: string): Promise<string | null>;
}

export class IssuePublicationError extends Error {
  constructor(readonly reason: IssuePublicationFailure, message = "GitHub could not publish the issue.", options?: ErrorOptions) {
    super(message, options);
    this.name = "IssuePublicationError";
  }
}

const AUTH_STATUS = ["auth", "status", "--hostname", "github.com"];

export function verifiedIssueUrl(text: string): string | null {
  const value = text.trim();
  return /^https:\/\/github\.com\/eduardtomas1\/inertia\/issues\/[1-9][0-9]*$/u.test(value) ? value : null;
}

export function classifyGitHubCliFailure(output: string): IssuePublicationFailure | null {
  const text = output.slice(0, 16_384);
  if (/error connecting to|check your internet connection|no such host|could not resolve host|dial tcp|network is unreachable|connection refused|connection reset|tls handshake timeout|i\/o timeout|timeout trying to log in/iu.test(text)) return "offline";
  if (/not logged in|gh auth login|http 401|bad credentials|token in .+ is invalid|requires authentication/iu.test(text)) return "signed-out";
  if (/rate limit|http 429|too many requests|abuse detection/iu.test(text)) return "rate-limited";
  if (/could not resolve to a repository|has disabled issues|http 404|http 403|resource not accessible/iu.test(text)) return "repository";
  return null;
}

function publicationFailure(error: unknown): IssuePublicationError {
  if (error instanceof IssuePublicationError) return error;
  if (!(error instanceof RestrictedCliError)) return new IssuePublicationError("unknown", undefined, { cause: error });
  const classified = error.reason !== "ready" && ISSUE_GITHUB_STATES.some((state) => state === error.reason) ? error.reason as IssuePublicationFailure : "unknown";
  const reason = error.code === "unavailable" ? "missing" : error.code === "timeout" ? "timeout" : classified;
  return new IssuePublicationError(reason, error.message, { cause: error });
}

/** Fixed repository and verbs; gh uses the user's existing credential store. Never forwards auth env vars. */
export function githubIssuePublisher(cwd: string, lifetime: AbortSignal, dependencies: GitHubPullRequestDependencies = {}): IssuePublisher {
  const execute = async <T>(operation: (run: (args: string[], input?: string) => Promise<string>) => Promise<T>, deadlineMs = 30_000): Promise<T> => {
    try {
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(deadlineMs)]);
      const gh = await resolveGitHubCli(dependencies, { signal });
      return await operation(async (args, input) => {
        const result = await runRestrictedCli(gh.executable, args, {
          cwd, environment: gh.environment, input, signal, timeoutMs: Math.min(25_000, deadlineMs), maxOutputBytes: 16_384,
          failureMessage: "GitHub could not complete this request. Sign in to GitHub CLI in Providers setup or continue in your browser.",
          classifyFailure: classifyGitHubCliFailure,
        }, dependencies);
        return result.stdout;
      });
    } catch (error) {
      throw publicationFailure(error);
    }
  };
  return {
    status: async () => {
      try {
        await execute(async (run) => await run(AUTH_STATUS), 10_000);
        return "ready";
      } catch (error) {
        return publicationFailure(error).reason;
      }
    },
    create: async ({ id, title, body, beforePublish }) => {
      if (!/^[0-9a-f-]{36}$/u.test(id) || title.length > 200 || body.length > REPORT_BODY_LIMIT) throw new Error("Invalid issue report.");
      return await execute(async (run) => {
        await run(AUTH_STATUS);
        beforePublish();
        const output = await run(["issue", "create", "--repo", ISSUE_REPOSITORY, "--title", title, "--body-file", "-"], `${body}\n\n<!-- inertia-report:${id} -->`);
        const url = verifiedIssueUrl(output);
        if (!url) throw new IssuePublicationError("unknown", "GitHub returned no verifiable issue URL.");
        return url;
      });
    },
    find: async (id) => {
      if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("Invalid report identity.");
      return await execute(async (run) => {
        // Filter inside gh so even ten maximum-size bodies cannot overflow the
        // bounded IPC output. The only interpolated value is a validated UUID.
        const projection = `.[] | select(.body | contains("<!-- inertia-report:${id} -->")) | .url`;
        const output = await run(["issue", "list", "--repo", ISSUE_REPOSITORY, "--state", "all", "--search", `in:body "inertia-report:${id}"`, "--limit", "10", "--json", "url,body", "--jq", projection]);
        for (const candidate of output.split(/\r?\n/u).slice(0, 10)) {
          const url = verifiedIssueUrl(candidate);
          if (url) return url;
        }
        return null;
      });
    },
  };
}
