export interface RemoteComponentVersions {
  browser: string;
  desktop: string;
  relay: string;
}

export function assertRemoteReadmeVersions(
  readme: string,
  versions: RemoteComponentVersions,
): void;

export function checkRemoteVersionConsistency(options?: {
  builtHtmlPath?: string;
}): Promise<RemoteComponentVersions>;
