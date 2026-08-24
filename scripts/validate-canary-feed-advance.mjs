import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export function parseCanaryFeedStatus(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== "tag\0version"
    || typeof value.version !== "string"
    || !VERSION_PATTERN.test(value.version)
    || value.tag !== `canary-v${value.version}`
  ) throw new Error(`${label} has an invalid Canary version or tag.`);
  return value;
}

export function compareCanaryVersions(left, right) {
  const leftParts = VERSION_PATTERN.exec(left);
  const rightParts = VERSION_PATTERN.exec(right);
  if (!leftParts || !rightParts) throw new Error("A Canary version is invalid.");
  for (let index = 1; index <= 3; index += 1) {
    const difference = BigInt(leftParts[index]) - BigInt(rightParts[index]);
    if (difference < 0n) return -1;
    if (difference > 0n) return 1;
  }
  return 0;
}

export function validateCanaryFeedAdvance(currentSource, candidateSource) {
  const candidate = parseCanaryFeedStatus(candidateSource, "Candidate Canary feed status");
  if (currentSource === null) return candidate;
  const current = parseCanaryFeedStatus(currentSource, "Published Canary feed status");
  if (compareCanaryVersions(candidate.version, current.version) <= 0) return null;
  return candidate;
}

function main() {
  const paths = process.argv.slice(2);
  if (paths.length < 1 || paths.length > 2) {
    throw new Error("Usage: validate-canary-feed-advance.mjs [current-status.json] candidate-status.json");
  }
  const candidatePath = paths.at(-1);
  const currentPath = paths.length === 2 ? paths[0] : null;
  const candidate = validateCanaryFeedAdvance(
    currentPath === null ? null : readFileSync(currentPath, "utf8"),
    readFileSync(candidatePath, "utf8"),
  );
  if (candidate === null) {
    console.log("The published Canary feed is already at this version or newer.");
    process.exitCode = 2;
    return;
  }
  console.log(`Verified monotonic Canary feed advance to ${candidate.tag}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
