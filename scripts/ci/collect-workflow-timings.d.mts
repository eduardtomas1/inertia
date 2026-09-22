export function elapsedSeconds(start: unknown, end: unknown): number | null;
export function summarizeAttempt(run: Record<string, unknown>, attempt: number, jobs: Array<Record<string, unknown>>): {
  runId: number; sourceHead: string; event: string; attempt: number; latestRunConclusion: string;
  recordedExecutionSeconds: number; unknownExecutionCount: number;
  jobs: Array<{ id: number; name: string; carriedForward: boolean; queueSeconds: number | null;
    executionSeconds: number | null; steps: Array<{ seconds: number | null }> }>;
};
export function collectWorkflowTimings(options: {
  repository: string; limit?: number; api?: (endpoint: string) => unknown;
}): Promise<{ attempts: ReturnType<typeof summarizeAttempt>[] }>;
