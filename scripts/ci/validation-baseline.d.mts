export interface ContractDifference { count: number; paths: string[]; truncated: boolean }
export interface BaselineResult {
  base: string | null;
  reason: string;
  failureClass?: string;
  diagnostics?: {
    evaluated: number; rejected: Record<string, number>;
    candidates: Array<{ runId: number | null; head: string | null; rejection: string; difference?: ContractDifference | null }>;
    truncated: boolean;
  };
  shadow?: BaselineResult;
}
export function boundedGit(args: string[], cwd?: string): string | null;
export function verificationContractAt(sha: string, cwd?: string, options?: { rendererDomShadow?: boolean }): string | null;
export function contractDifference(base: string, head: string, cwd?: string): ContractDifference | null;
export function comparisonPaths(base: string, head: string, cwd?: string): string[] | null;
export function selectMainBaseline(options: {
  runs: unknown[];
  head: string;
  repository: string;
  workflowId: number;
  currentRunId: number;
  contractAt: (sha: string) => string | null;
  isAncestor: (base: string, head: string) => boolean;
  hasSuccessfulGate: (run: object) => Promise<boolean>;
  differenceAt?: (base: string, head: string) => ContractDifference | null;
}): Promise<BaselineResult>;
export function githubApi(endpoint: string, timeoutMs?: number): unknown;
export function currentRunJobs(repository: string, runId: number, deadlineAt?: number,
  api?: (endpoint: string, timeoutMs?: number) => unknown): import("./evidence-plan.mjs").JobEvidence[];
export function resolveMainBaseline(options: {
  head: string; repository: string; runId: number;
  api?: (endpoint: string, timeoutMs?: number) => unknown;
  cwd?: string;
  rendererDomShadow?: boolean;
}): Promise<BaselineResult>;
