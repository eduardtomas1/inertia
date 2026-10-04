const RELEASE_REPOSITORY_HOSTS = ["github.com", "gitlab.com"] as const;

export const RELEASE_REPOSITORY_URL_MAX_LENGTH = 500;

export interface ReleaseRepositoryLocation {
  host: (typeof RELEASE_REPOSITORY_HOSTS)[number];
  segments: string[];
}

export function releaseRepositoryLocation(value: string): ReleaseRepositoryLocation | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > RELEASE_REPOSITORY_URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  const host = RELEASE_REPOSITORY_HOSTS.find((candidate) => candidate === parsed.hostname.toLowerCase());
  if (!host) return null;
  const segments = parsed.pathname.replace(/\.git$/u, "").replace(/\/+$/u, "").split("/").filter(Boolean);
  return segments.length >= 2 ? { host, segments } : null;
}

export function isReleaseRepositoryUrl(value: string): boolean {
  return releaseRepositoryLocation(value) !== null;
}
