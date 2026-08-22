type UnknownRecord = Record<string, unknown>;

const EVIDENCE_STATES = [
  "passed", "failed", "pending", "skipped", "cancelled", "neutral",
  "missing", "unknown",
] as const;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function strings(value: unknown, ...keys: string[]): value is UnknownRecord {
  return record(value) && keys.every((key) => stringField(value, key));
}

function nullableString(value: UnknownRecord, key: string): boolean {
  return value[key] === null || stringField(value, key);
}

function integer(value: UnknownRecord, key: string): boolean {
  return Number.isSafeInteger(value[key]);
}

function oneOf(
  value: UnknownRecord,
  key: string,
  options: readonly string[],
): boolean {
  return typeof value[key] === "string" && options.includes(value[key] as string);
}

function arrayOf(value: unknown, validate: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(validate);
}

function check(value: unknown): boolean {
  return strings(value, "name", "state")
    && oneOf(value, "state", EVIDENCE_STATES)
    && nullableString(value, "workflow")
    && nullableString(value, "detailsUrl")
    && nullableString(value, "startedAt")
    && nullableString(value, "completedAt");
}

function platform(value: unknown): boolean {
  return strings(value, "platform", "state")
    && oneOf(value, "platform", ["Linux", "Windows", "macOS"])
    && oneOf(value, "state", EVIDENCE_STATES)
    && arrayOf(value.checks, (entry) => typeof entry === "string");
}

function reviewThread(value: unknown): boolean {
  return strings(value, "id", "path", "author", "body")
    && (value.line === null || typeof value.line === "number" && Number.isFinite(value.line))
    && nullableString(value, "url")
    && typeof value.codex === "boolean"
    && typeof value.outdated === "boolean";
}

function file(value: unknown): boolean {
  return strings(value, "path", "area")
    && integer(value, "insertions")
    && Number(value.insertions) >= 0
    && integer(value, "deletions")
    && Number(value.deletions) >= 0;
}

function area(value: unknown): boolean {
  return strings(value, "name")
    && integer(value, "files")
    && Number(value.files) >= 1;
}

export function validatePreMergeConfidence(value: unknown): boolean {
  if (!strings(value, "generatedAt", "state")) return false;
  if (!oneOf(value, "state", ["ready", "no-pull-request", "unavailable"])
    || !nullableString(value, "unavailableReason")
    || !record(value.local)
    || !nullableString(value.local, "branch")
    || !nullableString(value.local, "head")
    || typeof value.local.dirty !== "boolean"
    || !arrayOf(value.local.files, (entry) => typeof entry === "string")
    || typeof value.local.filesTruncated !== "boolean"
    || !strings(value.identity, "state", "detail")
    || !oneOf(value.identity, "state", ["exact", "mismatch", "changed", "unavailable"])
    || !arrayOf(value.checks, check)
    || typeof value.checksTruncated !== "boolean"
    || !arrayOf(value.platforms, platform)
    || !arrayOf(value.reviewThreads, reviewThread)
    || typeof value.reviewThreadsTruncated !== "boolean"
    || !arrayOf(value.files, file)
    || !integer(value, "totalFiles")
    || Number(value.totalFiles) < 0
    || typeof value.filesTruncated !== "boolean"
    || !arrayOf(value.areas, area)
    || !arrayOf(value.changedTestFiles, (entry) => typeof entry === "string")
    || !arrayOf(value.focusedTestChecks, (entry) => typeof entry === "string")
    || !strings(value.bundle, "state", "summary")
    || !oneOf(value.bundle, "state", ["published", "not-published"])
    || !strings(value.mergeReadiness, "state")
    || !oneOf(value.mergeReadiness, "state", ["ready", "blocked", "pending", "unknown"])
    || !arrayOf(value.mergeReadiness.blockers, (entry) => typeof entry === "string")
    || !strings(value.releaseReadiness, "state", "detail")
    || value.releaseReadiness.state !== "not-proven") {
    return false;
  }
  if (value.github !== null && (!strings(
    value.github,
    "repository", "url", "title", "state", "headBranch", "head",
    "baseBranch", "mergeState", "updatedAt",
  )
    || !integer(value.github, "number")
    || Number(value.github.number) < 1
    || typeof value.github.draft !== "boolean"
    || !nullableString(value.github, "reviewDecision"))) {
    return false;
  }
  return value.authorClaim === null || (
    strings(value.authorClaim, "source", "body")
    && value.authorClaim.source === "pull-request-body"
    && typeof value.authorClaim.truncated === "boolean"
  );
}
