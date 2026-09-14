import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareCanaryVersions as compareVersions } from "./validate-canary-feed-advance.mjs";

// Stable and Canary feeds use the same exact three-integer version ordering.
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
function version(tag) {
  if (typeof tag !== "string" || tag.length > 128 || !STABLE_TAG.test(tag)) {
    throw new Error("The stable release tag is not an exact semantic version.");
  }
  return tag.slice(1);
}

/** Call while holding the stable publication job's concurrency group. */
export function shouldMarkStableReleaseLatest(candidateTag, releases) {
  const candidate = version(candidateTag);
  if (!Array.isArray(releases) || releases.length > 10_000) {
    throw new Error("Published release metadata is invalid or too large.");
  }
  let newer = true;
  for (const release of releases) {
    if (!release || typeof release !== "object" || Array.isArray(release)
      || typeof release.tag_name !== "string"
      || typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean") {
      throw new Error("Published release metadata is incomplete.");
    }
    if (release.draft || release.prerelease) continue;
    if (compareVersions(candidate, version(release.tag_name)) <= 0) newer = false;
  }
  return newer;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [tag, path, extra] = process.argv.slice(2);
  if (!tag || !path || extra || statSync(path).size > 4 * 1024 * 1024) {
    throw new Error("Usage: stable-release-latest.mjs <stable-tag> <bounded-release-list.json>");
  }
  console.log(shouldMarkStableReleaseLatest(tag, JSON.parse(readFileSync(path, "utf8"))));
}
