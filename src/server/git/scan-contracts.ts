export type GitScanScope = "status" | "workspace";

export interface ValidatedGitScanIdentity {
  readonly repositoryRoot: string;
  readonly metadataMarkerIdentity: string;
  readonly key: string;
}

export interface GitScanRequest {
  /** Validated caller binding. Different bindings never share results. */
  authorityGeneration: string;
  /** Monotonic mutation invalidation for this repository identity. */
  invalidation: number;
  identity: ValidatedGitScanIdentity;
  /** Options affecting the scan result, excluding caller wait deadlines. */
  optionsKey: string;
  scope: GitScanScope;
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface GitScanExecution {
  deadlineAt: number;
  invalidation: number;
  scope: GitScanScope;
  signal: AbortSignal;
}
