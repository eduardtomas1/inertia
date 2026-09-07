import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = "database-migration-lineage.json";
const MAX_HISTORY_MANIFEST_REVISIONS = 1_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_PATH_PATTERN = /^src\/[A-Za-z0-9._/-]{1,240}\.ts$/u;
const SOURCE_SYMBOL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,119}$/u;

export function parseLineage(source, label) {
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
    || value.format !== 2
    || !Array.isArray(value.migrations)
    || Object.keys(value).sort().join("\0") !== "format\0migrations"
  ) throw new Error(`${label} has an invalid shape.`);
  const names = new Set();
  for (const [index, migration] of value.migrations.entries()) {
    const migrationKeys = Object.keys(migration ?? {}).sort().join("\0");
    if (
      typeof migration !== "object"
      || migration === null
      || Array.isArray(migration)
      || (migrationKeys !== "digest\0name\0version"
        && migrationKeys !== "digest\0name\0sources\0version")
      || migration.version !== index + 1
      || typeof migration.name !== "string"
      || migration.name.length === 0
      || migration.name.length > 160
      || names.has(migration.name)
      || typeof migration.digest !== "string"
      || !DIGEST_PATTERN.test(migration.digest)
    ) throw new Error(`${label} has an invalid migration at version ${index + 1}.`);
    if (migration.sources !== undefined) {
      if (!Array.isArray(migration.sources) || migration.sources.length === 0) {
        throw new Error(`${label} has invalid implementation sources at version ${index + 1}.`);
      }
      let priorPath = "";
      for (const source of migration.sources) {
        if (
          typeof source !== "object"
          || source === null
          || Array.isArray(source)
          || Object.keys(source).sort().join("\0") !== "digest\0path\0symbols"
          || typeof source.path !== "string"
          || !SOURCE_PATH_PATTERN.test(source.path)
          || source.path.includes("..")
          || source.path <= priorPath
          || !Array.isArray(source.symbols)
          || source.symbols.length === 0
          || source.symbols.some((symbol, symbolIndex) =>
            typeof symbol !== "string"
            || !SOURCE_SYMBOL_PATTERN.test(symbol)
            || (symbolIndex > 0 && symbol <= source.symbols[symbolIndex - 1]))
          || typeof source.digest !== "string"
          || !DIGEST_PATTERN.test(source.digest)
        ) {
          throw new Error(`${label} has invalid implementation sources at version ${index + 1}.`);
        }
        priorPath = source.path;
      }
    }
    names.add(migration.name);
  }
  return value;
}

export function validateLineageExtension(base, current) {
  if (current.migrations.length < base.migrations.length) {
    throw new Error("Released database migrations were removed.");
  }
  for (const [index, released] of base.migrations.entries()) {
    const candidate = current.migrations[index];
    if (
      candidate.version !== released.version
      || candidate.name !== released.name
      || candidate.digest !== released.digest
      || JSON.stringify(candidate.sources ?? []) !== JSON.stringify(released.sources ?? [])
    ) {
      throw new Error(
        `Released database migration ${released.version} (${released.name}) was edited, removed, or reordered.`,
      );
    }
  }
}

function gitShow(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (stderr.includes("does not exist") || stderr.includes("exists on disk, but not in")) {
      return null;
    }
    throw error;
  }
}

function main() {
  const current = parseLineage(
    readFileSync(MANIFEST_PATH, "utf8"),
    "Current database migration lineage",
  );
  const baseRefIndex = process.argv.indexOf("--base-ref");
  const allHistory = process.argv.includes("--all-history");
  if (baseRefIndex >= 0 && allHistory) throw new Error("Choose --base-ref or --all-history, not both.");
  if (baseRefIndex >= 0) {
    const baseRef = process.argv[baseRefIndex + 1];
    if (!baseRef || baseRef.startsWith("-")) throw new Error("--base-ref requires a Git ref.");
    const source = gitShow(baseRef, MANIFEST_PATH);
    if (source) {
      validateLineageExtension(
        parseLineage(source, "Released database migration lineage"),
        current,
      );
    }
  }
  if (allHistory) {
    // A repository-root comparison can predate the manifest and prove nothing.
    // Enumerate every reachable manifest revision, including merged histories;
    // unavailable, oversized or unknown-format history must not grant approval.
    const history = execFileSync("git", [
      "log", "--full-history", `--max-count=${MAX_HISTORY_MANIFEST_REVISIONS + 1}`,
      "--format=%H", "HEAD", "--", MANIFEST_PATH,
    ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000 });
    const revisions = history.trim() ? history.trim().split("\n") : [];
    if (revisions.length > MAX_HISTORY_MANIFEST_REVISIONS
      || revisions.some((ref) => !/^[0-9a-f]{40}$/u.test(ref))) {
      throw new Error("Complete database migration history exceeds its safe verification bound.");
    }
    for (const ref of revisions) {
      const source = gitShow(ref, MANIFEST_PATH);
      if (source) validateLineageExtension(parseLineage(source, `Database migration lineage at ${ref}`), current);
    }
  }
  console.log(`Verified ${current.migrations.length} immutable database migration lineage entries.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
