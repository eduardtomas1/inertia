export interface PortableTestMarkers {
  harnessId: string | null;
}

export interface PortableTestManifest {
  files: string[];
  harnessTests: Record<string, string>;
}

export function parsePortableMarkers(
  source: string,
  path: string,
): PortableTestMarkers | null;

export function discoverPortableTests(
  repositoryRoot?: string,
): Promise<PortableTestManifest>;
