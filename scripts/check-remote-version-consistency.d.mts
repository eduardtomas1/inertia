export interface RemoteComponentVersions {
  browser: string;
  desktop: string;
  relay: string;
}

export function checkRemoteVersionConsistency(options?: {
  builtHtmlPath?: string;
}): Promise<RemoteComponentVersions>;
