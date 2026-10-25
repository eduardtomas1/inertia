type GitHubCall = (parameters: Record<string, unknown>) => Promise<unknown>;
export interface NightlyReportGitHub {
  paginate(method: GitHubCall, parameters: Record<string, unknown>): Promise<unknown[]>;
  rest: {
    actions: { listJobsForWorkflowRun: GitHubCall; listWorkflowRuns: GitHubCall };
    issues: {
      listForRepo: GitHubCall;
      listComments: GitHubCall;
      create: GitHubCall;
      createComment: GitHubCall;
      update: GitHubCall;
    };
  };
}
export interface NightlyReportContext {
  repo: { owner: string; repo: string };
  runId: number;
  runNumber: number;
  sha: string;
  serverUrl: string;
}
export type NightlyReportAction = "none" | "created" | "reopened" | "commented" | "closed";
export const PREVIOUS_NIGHTLY_TIMEOUT_MS: number;
export function previousNightlyConclusion(options: {
  github: NightlyReportGitHub;
  context: NightlyReportContext;
  workflowId: string;
  timeoutMs?: number;
}): Promise<string | null>;
export function reportNightly(options: {
  github: NightlyReportGitHub;
  context: NightlyReportContext;
  mergeReadyResult: string | undefined;
  workflowId: string;
  timeoutMs?: number;
}): Promise<NightlyReportAction>;
