import type { JobEvidence, ReusedRun } from "./evidence-plan.mjs";
export interface CertifiedPullRequestResult {
  reused: ReusedRun | null;
  base?: string;
  reason: string;
}
export function boundedGit(args: string[], cwd?: string): string | null;
export function comparisonPaths(base: string, head: string, cwd?: string): string[] | null;
export function githubApi(endpoint: string, timeoutMs?: number): unknown;
export function currentRunJobs(repository: string, runId: number, deadlineAt?: number,
  api?: (endpoint: string, timeoutMs?: number) => unknown): JobEvidence[];
export function resolveCertifiedPullRequest(options: {
  head: string; repository: string; runId: number;
  api?: (endpoint: string, timeoutMs?: number) => unknown;
  git?: (args: string[]) => string | null;
  now?: () => number;
}): Promise<CertifiedPullRequestResult>;
