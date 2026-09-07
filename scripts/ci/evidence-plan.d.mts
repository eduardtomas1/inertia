export interface NativePlatform {
  label: string;
  runner: string;
  artifact: string;
  arch: string;
  timeout_minutes: number;
  package_script?: string;
  release_platform?: string;
  release_package_script?: string;
  app_path: string;
  unpacked_dir?: string;
  docker_platform?: string;
}
export interface EvidencePlanOptions {
  head: string;
  sourceHead?: string;
  base?: string | null;
  baselineReason?: string;
  event?: string;
  draft?: boolean;
  paths?: string[];
}
export interface EvidencePlan {
  schemaVersion: 1;
  head: string;
  sourceHead: string;
  base: string | null;
  baselineReason: string;
  event: string;
  lane: string;
  paths: string[];
  domains: string[];
  reasons: string[];
  fullCertification: boolean;
  requiredJobs: string[];
  requiredChecks: string[];
  platforms: string[];
  omittedPlatforms: Array<{ platform: string; reason: string }>;
  suites: string[];
  matrix: { include: NativePlatform[] };
  renderer: boolean;
  benchmarks: boolean;
  omissions: Array<{ job: string; reason: string }>;
}
export interface JobEvidence {
  name: string;
  run_id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
}
export const PLATFORMS: readonly NativePlatform[];
export const EVIDENCE_JOBS: Readonly<Record<string, string>>;
export function createEvidencePlan(options: EvidencePlanOptions): EvidencePlan;
export function outputsForEvidencePlan(plan: EvidencePlan): string;
export function evaluateMergeEvidence(plan: EvidencePlan | null, evidence: {
  head: string;
  sourceHead: string;
  event: string;
  draft: boolean;
  runId: number;
  needs: Record<string, { result: string } | undefined>;
  jobs: JobEvidence[];
}): string[];
