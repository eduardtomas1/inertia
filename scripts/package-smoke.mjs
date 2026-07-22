import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STARTUP_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const MAX_OUTPUT_LENGTH = 64 * 1024;

function sleep(milliseconds) {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

async function isExecutableFile(path) {
  try {
    const value = await stat(path);
    if (!value.isFile()) return false;
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function locatePackagedExecutable() {
  const releaseDirectory = resolve("release");
  const candidates = process.platform === "darwin"
    ? [
        join(releaseDirectory, `mac-${process.arch}`, "Inertia.app", "Contents", "MacOS", "Inertia"),
        join(releaseDirectory, "mac", "Inertia.app", "Contents", "MacOS", "Inertia"),
      ]
    : process.platform === "win32"
      ? [join(releaseDirectory, "win-unpacked", "Inertia.exe")]
      : process.platform === "linux"
        ? [join(releaseDirectory, "linux-unpacked", "inertia")]
        : [];
  const matches = [];
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one packaged executable for ${process.platform}/${process.arch}; found ${matches.length}.`);
  }
  return matches[0];
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function processGroupExists(pid) {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function forceTerminateProcessTree(mainPid, runtimePid) {
  const validPids = [...new Set([mainPid, runtimePid].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (process.platform === "win32") {
    for (const pid of validPids) {
      if (processExists(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
    return;
  }
  if (Number.isSafeInteger(mainPid) && mainPid > 0 && processGroupExists(mainPid)) {
    try { process.kill(-mainPid, "SIGKILL"); } catch { /* The process group may already be gone. */ }
  }
  for (const pid of validPids) {
    if (!processExists(pid)) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* The process may already be gone. */ }
  }
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}.`);
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function parseReadiness(value, expectedMainPid) {
  if (!value || typeof value !== "object") return null;
  const { mainPid, runtimePid, generation } = value;
  if (mainPid !== expectedMainPid
    || !Number.isSafeInteger(runtimePid)
    || runtimePid <= 0
    || runtimePid === mainPid
    || !Number.isSafeInteger(generation)
    || generation < 1) return null;
  return { mainPid, runtimePid, generation };
}

async function requireLifecycleMarker(markerPath, stage, mainPid) {
  const value = await waitUntil(
    () => readJsonIfPresent(`${markerPath}.${stage}.json`),
    2_000,
    `${stage} lifecycle marker`,
  );
  if (value.stage !== stage || value.pid !== mainPid) throw new Error(`Invalid ${stage} lifecycle marker.`);
}

function appendOutput(current, chunk) {
  const combined = current + chunk.toString("utf8");
  return combined.length <= MAX_OUTPUT_LENGTH ? combined : combined.slice(-MAX_OUTPUT_LENGTH);
}

const executable = await locatePackagedExecutable();
const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-package-smoke-"));
const markerPath = join(temporaryRoot, "ready.json");
const dataDirectory = join(temporaryRoot, "data");
const workspaceDirectory = join(temporaryRoot, "workspace");
const profileDirectory = join(temporaryRoot, "profile");
let child = null;
let readiness = null;
let stdout = "";
let stderr = "";

try {
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);
  child = spawn(executable, [`--user-data-dir=${profileDirectory}`], {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: dataDirectory,
      INERTIA_WORKSPACE_DIR: workspaceDirectory,
      INERTIA_PACKAGE_SMOKE_FILE: markerPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
  child.stderr?.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });

  const exitResult = new Promise((settle) => {
    child.once("error", (error) => settle({ error, code: null, signal: null }));
    child.once("exit", (code, signal) => settle({ error: null, code, signal }));
  });
  readiness = await Promise.race([
    waitUntil(async () => {
      const candidate = parseReadiness(await readJsonIfPresent(markerPath), child.pid);
      return candidate ?? null;
    }, STARTUP_TIMEOUT_MS, "packaged app and utility runtime readiness"),
    exitResult.then((earlyExit) => {
      if (earlyExit.error) throw earlyExit.error;
      throw new Error(`The packaged app exited before reporting readiness (${earlyExit.code ?? earlyExit.signal ?? "unknown"}).`);
    }),
  ]);
  const runtimeWasObserved = processExists(readiness.runtimePid);

  const exit = await Promise.race([
    exitResult,
    sleep(EXIT_TIMEOUT_MS).then(() => { throw new Error("The packaged app did not finish its smoke-test shutdown."); }),
  ]);
  if (exit.error) throw exit.error;
  await requireLifecycleMarker(markerPath, "before-quit", readiness.mainPid);
  await requireLifecycleMarker(markerPath, "runtime-stopped", readiness.mainPid);
  await requireLifecycleMarker(markerPath, "app-exit", readiness.mainPid);

  await waitUntil(
    () => !processExists(readiness.mainPid) && !processExists(readiness.runtimePid),
    CLEANUP_TIMEOUT_MS,
    "main and utility runtime process cleanup",
  );
  if (process.platform !== "win32") {
    await waitUntil(() => !processGroupExists(readiness.mainPid), CLEANUP_TIMEOUT_MS, "packaged app process-group cleanup");
  }
  console.log(`Packaged smoke passed (${process.platform}/${process.arch}); main=${readiness.mainPid}, runtime=${readiness.runtimePid}, generation=${readiness.generation}, runtimeObserved=${runtimeWasObserved}, exit=${exit.code ?? exit.signal ?? "unknown"}.`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (stdout.trim()) console.error(`Packaged app stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`Packaged app stderr:\n${stderr.trim()}`);
  throw new Error(`Packaged smoke failed: ${detail}`, { cause: error });
} finally {
  const mainPid = child?.pid ?? null;
  const runtimePid = readiness?.runtimePid ?? null;
  if ((mainPid && (processExists(mainPid) || processGroupExists(mainPid))) || (runtimePid && processExists(runtimePid))) {
    forceTerminateProcessTree(mainPid, runtimePid);
    await waitUntil(
      () => (!mainPid || (!processExists(mainPid) && !processGroupExists(mainPid))) && (!runtimePid || !processExists(runtimePid)),
      CLEANUP_TIMEOUT_MS,
      "forced packaged process cleanup",
    );
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
