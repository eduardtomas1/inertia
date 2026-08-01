export interface RemoteArtifactInput {
  kind: "browser" | "relay";
  version: string;
  nodeRange: string;
  lockfilePath: string;
  entries: Array<{ path: string; data: Buffer }>;
}

export function buildRemoteArtifacts(options?: {
  outputDirectory?: string;
  sourceCommit?: string;
  browserDirectory?: string;
  relayDirectory?: string;
}): Promise<{
  outputDirectory: string;
  artifacts: Array<{ name: string; sha256: string; size: number }>;
}>;

export function writeRemoteArtifactSet(options: {
  outputDirectory: string;
  sourceCommit: string;
  components: RemoteArtifactInput[];
}): Promise<{
  outputDirectory: string;
  artifacts: Array<{ name: string; sha256: string; size: number }>;
}>;

export function verifyRemoteArtifacts(directory?: string): Promise<true>;
