export interface BaselineResult { base: string | null; reason: string }
export function boundedGit(args: string[], cwd?: string): string | null;
export function verificationContractAt(sha: string, cwd?: string): string | null;
export function comparisonPaths(base: string, head: string, cwd?: string): string[] | null;
export function selectMainBaseline(options: {
  runs: object[];
  head: string;
  repository: string;
  workflowId: number;
  currentRunId: number;
  contractAt: (sha: string) => string | null;
  isAncestor: (base: string, head: string) => boolean;
  hasSuccessfulGate: (run: object) => Promise<boolean>;
}): Promise<BaselineResult>;
export function resolveMainBaseline(options: {
  head: string; repository: string; runId: number;
}): Promise<BaselineResult>;
