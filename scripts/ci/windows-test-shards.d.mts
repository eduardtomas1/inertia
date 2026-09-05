export interface WindowsDurationSource {
  workflowRunId: number;
  workflowUrl: string;
  headSha: string;
  conclusion: "success";
  jobIds: number[];
  observedShardTestDurationMs: number[];
  observedShardVitestDurationMs: number[];
}

export interface WindowsDurationDefaults {
  perFileOverheadMs: number;
  unknownTestDurationMs: number;
}

export interface WindowsDurationManifest {
  schemaVersion: 1;
  platform: "windows-x64";
  source: WindowsDurationSource;
  defaults: WindowsDurationDefaults;
  durationsMs: Record<string, number>;
}

export interface WindowsTestShard {
  index: number;
  weightMs: number;
  measuredFiles: number;
  unknownFiles: number;
  files: string[];
}

export function validateWindowsDurationManifest(input: unknown): WindowsDurationManifest;

export function createDurationAwareShards(
  files: readonly string[],
  durationsMs: Readonly<Record<string, number>>,
  shardCount: number,
  defaults: WindowsDurationDefaults,
): WindowsTestShard[];

export function discoverVitestFiles(repositoryRoot?: string): Promise<string[]>;

export function loadWindowsDurationManifest(
  repositoryRoot?: string,
  manifestPath?: string,
): Promise<WindowsDurationManifest>;
