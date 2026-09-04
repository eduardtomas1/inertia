import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const SUITE_MARKER = "// @inertia-test-suite portable";
const HARNESS_MARKER = /^\/\/ @inertia-harness ([a-z][a-z0-9-]{0,63})$/u;
const TEST_FILE = /\.test\.(?:ts|tsx)$/u;
const MAX_TEST_FILES = 4_096;
const MAX_TEST_BYTES = 8 * 1024 * 1024;

function repositoryPath(repositoryRoot, absolutePath) {
  const path = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
  if (
    path.length === 0
    || path.startsWith("../")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Portable test discovery escaped the repository root.");
  }
  return path;
}

async function discoverFiles(directory, result) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Portable test discovery rejects symbolic links: ${path}`);
    }
    if (entry.isDirectory()) await discoverFiles(path, result);
    else if (entry.isFile() && TEST_FILE.test(entry.name)) result.push(path);
    if (result.length > MAX_TEST_FILES) {
      throw new Error(`Portable test discovery exceeds ${MAX_TEST_FILES} files.`);
    }
  }
}

export function parsePortableMarkers(source, path) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== SUITE_MARKER) return null;
  const harnessMatch = lines[1]?.match(HARNESS_MARKER) ?? null;
  if (lines[1]?.startsWith("// @inertia-harness ") && !harnessMatch) {
    throw new Error(`${path} has an invalid portable harness marker.`);
  }
  return { harnessId: harnessMatch?.[1] ?? null };
}

export async function discoverPortableTests(repositoryRoot = process.cwd()) {
  const root = resolve(repositoryRoot);
  const testRoot = resolve(root, "tests");
  const candidates = [];
  await discoverFiles(testRoot, candidates);

  const files = [];
  const harnessTests = {};
  for (const absolutePath of candidates) {
    const path = repositoryPath(root, absolutePath);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.size > MAX_TEST_BYTES) {
      throw new Error(`${path} is not a bounded regular test file.`);
    }
    const markers = parsePortableMarkers(await readFile(absolutePath, "utf8"), path);
    if (markers === null) continue;
    files.push(path);
    if (markers.harnessId !== null) {
      if (harnessTests[markers.harnessId]) {
        throw new Error(`Portable harness '${markers.harnessId}' is registered more than once.`);
      }
      harnessTests[markers.harnessId] = path;
    }
  }
  if (files.length === 0) throw new Error("Portable test discovery found no marked tests.");
  return { files, harnessTests };
}
