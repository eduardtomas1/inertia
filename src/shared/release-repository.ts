const RELEASE_REPOSITORY_HOSTS = new Set(["github.com", "gitlab.com"]);

export const RELEASE_REPOSITORY_URL_MAX_LENGTH = 500;

export function isReleaseRepositoryUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > RELEASE_REPOSITORY_URL_MAX_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
  if (!RELEASE_REPOSITORY_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  return parsed.pathname.replace(/\.git$/u, "").split("/").filter(Boolean).length >= 2;
}
