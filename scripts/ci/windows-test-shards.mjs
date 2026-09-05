import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST_PATH = ".github/test-durations/windows-x64.json";
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_TEST_FILES = 4_096;
const MAX_SHARDS = 16;
const MAX_DURATION_MS = 15 * 60 * 1_000;
const MAX_SHARD_TOTAL_MS = 24 * 60 * 60 * 1_000;
const TEST_FILE = /\.test\.(?:ts|tsx)$/u;
const BENCHMARK_FILE = /\/performance\/.*\.benchmark\.test\.(?:ts|tsx)$/u;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeTestPath(path) {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > 512
    || !path.startsWith("tests/")
    || !TEST_FILE.test(path)
    || path.includes("\\")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Windows duration manifest contains unsafe test path '${String(path)}'.`);
  }
}

function assertBoundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  if (
    !isPlainRecord(value)
    || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  ) {
    throw new Error(`${label} has an invalid shape.`);
  }
}

export function validateWindowsDurationManifest(input) {
  assertExactKeys(
    input,
    ["schemaVersion", "platform", "source", "defaults", "durationsMs"],
    "Windows duration manifest",
  );
  const manifest = input;
  if (manifest.schemaVersion !== 1 || manifest.platform !== "windows-x64") {
    throw new Error("Windows duration manifest has an unsupported identity.");
  }
  assertExactKeys(manifest.source, [
    "workflowRunId",
    "workflowUrl",
    "headSha",
    "conclusion",
    "jobIds",
    "observedShardTestDurationMs",
    "observedShardVitestDurationMs",
  ], "Windows duration manifest source");
  if (
    manifest.source.conclusion !== "success"
    || !Number.isSafeInteger(manifest.source.workflowRunId)
    || manifest.source.workflowRunId <= 0
    || !/^[0-9a-f]{40}$/u.test(manifest.source.headSha)
    || !Array.isArray(manifest.source.jobIds)
    || manifest.source.jobIds.length === 0
    || manifest.source.jobIds.length > MAX_SHARDS
    || manifest.source.jobIds.some((jobId) => !Number.isSafeInteger(jobId) || jobId <= 0)
    || new Set(manifest.source.jobIds).size !== manifest.source.jobIds.length
    || manifest.source.workflowUrl !== `https://github.com/eduardtomas1/inertia/actions/runs/${manifest.source.workflowRunId}`
  ) {
    throw new Error("Windows duration manifest requires one bounded successful-run provenance record.");
  }
  for (const [label, totals] of [
    ["observedShardTestDurationMs", manifest.source.observedShardTestDurationMs],
    ["observedShardVitestDurationMs", manifest.source.observedShardVitestDurationMs],
  ]) {
    if (!Array.isArray(totals) || totals.length !== manifest.source.jobIds.length) {
      throw new Error(`${label} must match the successful shard jobs.`);
    }
    for (const total of totals) {
      assertBoundedInteger(total, label, 1, MAX_SHARD_TOTAL_MS);
    }
  }
  assertExactKeys(
    manifest.defaults,
    ["perFileOverheadMs", "unknownTestDurationMs"],
    "Windows duration manifest defaults",
  );
  assertBoundedInteger(
    manifest.defaults.perFileOverheadMs,
    "perFileOverheadMs",
    0,
    60_000,
  );
  assertBoundedInteger(
    manifest.defaults.unknownTestDurationMs,
    "unknownTestDurationMs",
    1,
    MAX_DURATION_MS,
  );
  if (
    !isPlainRecord(manifest.durationsMs)
  ) {
    throw new Error("Windows duration manifest requires a durationsMs object.");
  }
  const entries = Object.entries(manifest.durationsMs);
  if (entries.length === 0 || entries.length > MAX_TEST_FILES) {
    throw new Error("Windows duration manifest has an unbounded file count.");
  }
  for (const [path, duration] of entries) {
    assertSafeTestPath(path);
    assertBoundedInteger(duration, `Duration for ${path}`, 0, MAX_DURATION_MS);
  }
  return manifest;
}

export function createDurationAwareShards(
  files,
  durationsMs,
  shardCount,
  { perFileOverheadMs, unknownTestDurationMs },
) {
  assertBoundedInteger(shardCount, "shardCount", 1, MAX_SHARDS);
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_TEST_FILES) {
    throw new Error("Windows shard planning requires a bounded non-empty test list.");
  }
  const uniqueFiles = new Set(files);
  if (uniqueFiles.size !== files.length) throw new Error("Windows shard planning rejects duplicate tests.");
  for (const path of files) assertSafeTestPath(path);

  const weighted = files.map((path) => ({
    path,
    measured: Object.hasOwn(durationsMs, path),
    testDurationMs: Object.hasOwn(durationsMs, path)
      ? durationsMs[path]
      : unknownTestDurationMs,
    weightMs: (Object.hasOwn(durationsMs, path) ? durationsMs[path] : unknownTestDurationMs)
      + perFileOverheadMs,
  })).sort((left, right) => right.weightMs - left.weightMs || comparePaths(left.path, right.path));

  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index: index + 1,
    weightMs: 0,
    measuredFiles: 0,
    unknownFiles: 0,
    files: [],
  }));
  for (const entry of weighted) {
    const target = [...shards].sort((left, right) => (
      left.weightMs - right.weightMs
      || left.files.length - right.files.length
      || left.index - right.index
    ))[0];
    target.files.push(entry.path);
    target.weightMs += entry.weightMs;
    if (entry.measured) target.measuredFiles += 1;
    else target.unknownFiles += 1;
  }
  for (const shard of shards) shard.files.sort(comparePaths);
  return shards;
}

async function discoverTestFiles(directory, repositoryRoot, result) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Windows test discovery rejects symbolic link '${absolutePath}'.`);
    }
    if (entry.isDirectory()) await discoverTestFiles(absolutePath, repositoryRoot, result);
    else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      const path = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
      if (!BENCHMARK_FILE.test(`/${path}`)) result.push(path);
    }
    if (result.length > MAX_TEST_FILES) throw new Error("Windows test discovery is unbounded.");
  }
}

export async function discoverVitestFiles(repositoryRoot = process.cwd()) {
  const root = resolve(repositoryRoot);
  const files = [];
  await discoverTestFiles(resolve(root, "tests"), root, files);
  files.sort(comparePaths);
  return files;
}

export async function loadWindowsDurationManifest(
  repositoryRoot = process.cwd(),
  manifestPath = DEFAULT_MANIFEST_PATH,
) {
  const root = resolve(repositoryRoot);
  const absolutePath = resolve(root, manifestPath);
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith("../") || relativePath === ".." || relativePath.startsWith("..\\")) {
    throw new Error("Windows duration manifest path escaped the repository root.");
  }
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
    throw new Error("Windows duration manifest is not a bounded regular file.");
  }
  return validateWindowsDurationManifest(JSON.parse(await readFile(absolutePath, "utf8")));
}

function parseArguments(args) {
  const parsed = { shardIndex: 0, shardCount: 0, planOnly: false, manifestPath: DEFAULT_MANIFEST_PATH };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const shardMatch = argument.match(/^--shard=([1-9]\d*)\/([1-9]\d*)$/u);
    if (shardMatch) {
      parsed.shardIndex = Number(shardMatch[1]);
      parsed.shardCount = Number(shardMatch[2]);
    } else if (argument === "--plan-only") parsed.planOnly = true;
    else if (argument === "--manifest") parsed.manifestPath = args[++index] ?? "";
    else throw new Error(`Unknown Windows shard argument '${argument}'.`);
  }
  assertBoundedInteger(parsed.shardCount, "shard count", 1, MAX_SHARDS);
  assertBoundedInteger(parsed.shardIndex, "shard index", 1, parsed.shardCount);
  return parsed;
}

async function main() {
  const repositoryRoot = process.cwd();
  const args = parseArguments(process.argv.slice(2));
  const [files, manifest] = await Promise.all([
    discoverVitestFiles(repositoryRoot),
    loadWindowsDurationManifest(repositoryRoot, args.manifestPath),
  ]);
  const shards = createDurationAwareShards(
    files,
    manifest.durationsMs,
    args.shardCount,
    manifest.defaults,
  );
  const selected = shards[args.shardIndex - 1];
  const plan = {
    source: manifest.source,
    selectedShard: args.shardIndex,
    shardCount: args.shardCount,
    totalFiles: files.length,
    shards,
  };
  if (args.planOnly) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Windows LPT shard ${args.shardIndex}/${args.shardCount}: ${selected.files.length} files, `
      + `${selected.measuredFiles} measured, ${selected.unknownFiles} conservative fallbacks, `
      + `${selected.weightMs}ms projected weight.\n`,
  );

  await mkdir(resolve(repositoryRoot, "test-results"), { recursive: true });
  const planPath = resolve(repositoryRoot, `test-results/windows-unit-${args.shardIndex}-plan.json`);
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const resultsPath = `test-results/windows-unit-${args.shardIndex}.json`;
  const vitestPath = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
  const result = spawnSync(process.execPath, [
    vitestPath,
    "run",
    "--maxWorkers=1",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${resultsPath}`,
    ...selected.files,
  ], { cwd: repositoryRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
