import { ISSUE_REPOSITORY, ISSUE_REPOSITORY_URL, REPORT_BODY_LIMIT } from "../../shared/issue-report";
import { resolveGitHubCli, type GitHubPullRequestDependencies } from "./github-pull-request";
import { runRestrictedCli } from "../restricted-cli-runner";

export interface IssuePublisher {
  create(input: { id: string; title: string; body: string; beforePublish(): void }): Promise<string>;
  find(id: string): Promise<string | null>;
}
export function verifiedIssueUrl(text: string): string | null {
  const value = text.trim();
  return /^https:\/\/github\.com\/eduardtomas1\/inertia\/issues\/[1-9][0-9]*$/u.test(value) ? value : null;
}

/** Fixed repository and verbs; gh uses the user's existing credential store. Never forwards auth env vars. */
export function githubIssuePublisher(cwd: string, lifetime: AbortSignal, dependencies: GitHubPullRequestDependencies = {}): IssuePublisher {
  const execute = async <T>(operation: (run: (args: string[], input?: string) => Promise<string>) => Promise<T>): Promise<T> => {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
    const gh = await resolveGitHubCli(dependencies, { signal });
    return await operation(async (args, input) => {
      const result = await runRestrictedCli(gh.executable, args, {
        cwd, environment: gh.environment, input, signal, timeoutMs: 25_000, maxOutputBytes: 16_384,
        failureMessage: "GitHub could not complete this request. Sign in to GitHub CLI in Providers setup or continue in your browser.",
      }, dependencies);
      return result.stdout;
    });
  };
  return {
    create: async ({ id, title, body, beforePublish }) => {
      if (!/^[0-9a-f-]{36}$/u.test(id) || title.length > 200 || body.length > REPORT_BODY_LIMIT) throw new Error("Invalid issue report.");
      return await execute(async (run) => {
        await run(["auth", "status", "--hostname", "github.com"]);
        beforePublish();
        const output = await run(["issue", "create", "--repo", ISSUE_REPOSITORY, "--title", title, "--body-file", "-"], `${body}\n\n<!-- inertia-report:${id} -->`);
        const url = verifiedIssueUrl(output);
        if (!url) throw new Error("GitHub returned no verifiable issue URL.");
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
export const MANUAL_ISSUE_URL = `${ISSUE_REPOSITORY_URL}/new`;
