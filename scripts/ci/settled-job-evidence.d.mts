export interface JobEvidence {
  name: string;
  run_id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
}
export function settledJobEvidence(options: {
  requiredChecks: string[];
  runId: number;
  sourceHead: string;
  readJobs: (deadlineAt: number) => JobEvidence[];
  wait: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<JobEvidence[]>;
