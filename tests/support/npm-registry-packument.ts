export interface RegistryReleaseFixture {
  hoursAgo?: number;
  deprecated?: string;
}

export function npmPackument(
  distTags: Readonly<Record<string, string>>,
  releases: Readonly<Record<string, RegistryReleaseFixture>>,
  now = Date.now(),
): Record<string, unknown> {
  const versions: Record<string, Record<string, unknown>> = {};
  const time: Record<string, string> = {};
  for (const [version, release] of Object.entries(releases)) {
    versions[version] = {
      version,
      ...(release.deprecated !== undefined ? { deprecated: release.deprecated } : {}),
    };
    time[version] = new Date(now - (release.hoursAgo ?? 96) * 3_600_000).toISOString();
  }
  return { "dist-tags": distTags, versions, time };
}

export function npmPackumentResponse(
  latest: string,
  releases: Readonly<Record<string, RegistryReleaseFixture>> = { [latest]: {} },
  now = Date.now(),
): Response {
  return new Response(JSON.stringify(npmPackument({ latest }, releases, now)));
}
