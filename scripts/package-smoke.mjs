import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";

const STARTUP_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const MAX_OUTPUT_LENGTH = 64 * 1024;

function sleep(milliseconds) {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const { mainPid, runtimePid, generation, websocketUrl } = value;
  if (mainPid !== expectedMainPid
    || !Number.isSafeInteger(runtimePid)
    || runtimePid <= 0
    || runtimePid === mainPid
    || !Number.isSafeInteger(generation)
    || generation < 1
    || typeof websocketUrl !== "string"
    || !websocketUrl.startsWith("ws://127.0.0.1:")) return null;
  return { mainPid, runtimePid, generation, websocketUrl };
}

async function createWindowsCodexFixture(root, workspace) {
  if (process.platform !== "win32") return null;
  const profile = join(root, "Packaged Codex Ω (profile)");
  // Native executable relocation and Unicode npm shims are covered
  // independently. Keep the synthetic native binary in an ASCII path so this
  // smoke isolates the packaged utility-process and provider boundaries.
  const directory = join(root, "codex-bin");
  const command = join(directory, "codex.exe");
  const login = join(workspace, "login");
  const appServer = join(workspace, "app-server");
  await mkdir(directory, { recursive: true });
  await copyFile(process.execPath, command);
  await writeFile(login, `
const args = process.argv.slice(2);
if (args[0] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
process.exit(2);
`.trimStart(), "utf8");
  await writeFile(appServer, `
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("codex app-server - Run the app server"); process.exit(0); }
if (args.length !== 0) process.exit(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "package-smoke" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null } });
  return send({ id: message.id, error: { code: -32601, message: "Unsupported package-smoke method" } });
});
`.trimStart(), "utf8");
  return { command, directory, profile };
}

async function createPdfFixture(root) {
  const inputPath = join(root, "package-smoke.pdf");
  const resultPath = join(root, "package-smoke-pdf-result.json");
  const text = "Packaged PDF extraction works";
  const stream = `BT /F1 22 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
      + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  await writeFile(inputPath, pdf, "ascii");
  return { inputPath, resultPath, text };
}

async function requirePackagedCodex(websocketUrl, expectedExecutable) {
  const canonicalExpectedExecutable = await realpath(expectedExecutable);
  await new Promise((resolveCodex, rejectCodex) => {
    const socket = new WebSocket(websocketUrl, { headers: { Origin: "http://127.0.0.1" } });
    const refreshRequestId = randomUUID();
    let refreshRequested = false;
    let refreshAcknowledged = false;
    let lastProviderState = "no provider snapshot";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) rejectCodex(error);
      else resolveCodex();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Packaged runtime did not discover the Windows Codex shim (${lastProviderState}; refresh requested: ${refreshRequested}; acknowledged: ${refreshAcknowledged}).`));
    }, 8_000);
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Packaged runtime closed before Codex discovery completed."));
    });
    socket.on("message", (data) => {
      let frame;
      try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
      const event = frame?.type === "runtime.event" ? frame.event : frame;
      if (event?.type === "request.ok" && event.requestId === refreshRequestId) {
        refreshAcknowledged = true;
        return;
      }
      if (event?.type === "request.error" && event.requestId === refreshRequestId) {
        finish(new Error(`Packaged Codex refresh failed: ${event.message || "unknown error"}.`));
        return;
      }
      if (event?.type !== "server.welcome" && event?.type !== "snapshot.updated") return;
      const provider = event.snapshot?.providers?.find(({ id }) => id === "codex");
      lastProviderState = provider
        ? `${provider.installState}/${provider.authState}/canRun=${provider.canRun}`
        : "Codex missing from snapshot";
      if (!provider || provider.installState === "checking") {
        if (!refreshRequested) {
          refreshRequested = true;
          socket.send(JSON.stringify({
            type: "provider.refresh",
            requestId: refreshRequestId,
            payload: { providerId: "codex" },
          }));
        }
        return;
      }
      if (provider.installState !== "installed" || provider.canRun !== true) {
        finish(new Error(`Packaged Codex discovery reported ${provider.statusMessage || provider.installState}.`));
        return;
      }
      if (resolve(provider.executable || "").toLocaleLowerCase("en-US") !== resolve(canonicalExpectedExecutable).toLocaleLowerCase("en-US")) {
        finish(new Error(`Packaged Codex discovery selected an unexpected executable: ${provider.executable || "none"}.`));
        return;
      }
      finish();
    });
  });
}

async function requireLifecycleMarker(
  markerPath,
  stage,
  mainPid,
  timeoutMs = 2_000,
) {
  const value = await waitUntil(
    () => readJsonIfPresent(`${markerPath}.${stage}.json`),
    timeoutMs,
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
let launchedAt = 0;

try {
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);
  const packagedCodex = await createWindowsCodexFixture(temporaryRoot, workspaceDirectory);
  const packagedPdf = await createPdfFixture(temporaryRoot);
  const launchArguments = [
    `--user-data-dir=${profileDirectory}`,
    ...(process.platform === "linux" && process.env.INERTIA_PACKAGE_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  ];
  launchedAt = Date.now();
  child = spawn(executable, launchArguments, {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: dataDirectory,
      INERTIA_WORKSPACE_DIR: workspaceDirectory,
      INERTIA_PACKAGE_SMOKE_FILE: markerPath,
      INERTIA_PACKAGE_SMOKE_PDF_INPUT: packagedPdf.inputPath,
      INERTIA_PACKAGE_SMOKE_PDF_RESULT: packagedPdf.resultPath,
      ...(packagedCodex ? {
        INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED: packagedCodex.command,
        APPDATA: packagedCodex.profile,
        LOCALAPPDATA: join(packagedCodex.profile, "Local"),
        USERPROFILE: packagedCodex.profile,
        CODEX_HOME: "",
        CODEX_INSTALL_DIR: "",
        PNPM_HOME: "",
        BUN_INSTALL: "",
        VOLTA_HOME: "",
        PATH: packagedCodex.directory,
        PATHEXT: ".EXE;.CMD;.BAT",
      } : {}),
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
  const readinessObservedAt = Date.now();
  const runtimeWasObserved = processExists(readiness.runtimePid);
  const pdfResult = await waitUntil(
    () => readJsonIfPresent(packagedPdf.resultPath),
    2_000,
    "packaged PDF extraction result",
  );
  if (
    pdfResult.ok !== true
    || typeof pdfResult.content !== "string"
    || !pdfResult.content.includes(packagedPdf.text)
  ) {
    throw new Error("The packaged PDF stack returned an invalid smoke result.");
  }
  if (packagedCodex) await requirePackagedCodex(readiness.websocketUrl, packagedCodex.command);

  // Provider discovery deliberately keeps the packaged app alive before
  // shutdown. Start the exit deadline only after Electron begins quitting so
  // that dwell time cannot consume the process-tree cleanup budget.
  await requireLifecycleMarker(
    markerPath,
    "before-quit",
    readiness.mainPid,
    EXIT_TIMEOUT_MS,
  );
  const shutdownObservedAt = Date.now();
  const exit = await withTimeout(
    exitResult,
    EXIT_TIMEOUT_MS,
    "The packaged app did not finish shutdown after before-quit.",
  );
  if (exit.error) throw exit.error;
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
  const benchmark = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    packageKind: process.platform === "linux" ? "linux-unpacked" : "unpacked",
    signingState: process.platform === "darwin" ? "ci-ad-hoc-or-local" : "not-recorded",
    launchToRuntimeReadyMs: readinessObservedAt - launchedAt,
    shutdownToProcessExitMs: Date.now() - shutdownObservedAt,
    mainPid: readiness.mainPid,
    runtimePid: readiness.runtimePid,
    generation: readiness.generation,
  };
  const benchmarkReport = process.env.INERTIA_PACKAGE_BENCHMARK_REPORT;
  if (benchmarkReport) {
    const target = resolve(benchmarkReport);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(benchmark, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  console.log(`Packaged smoke passed (${process.platform}/${process.arch}); main=${readiness.mainPid}, runtime=${readiness.runtimePid}, generation=${readiness.generation}, runtimeObserved=${runtimeWasObserved}, pdfExtraction=true, launchToReadyMs=${benchmark.launchToRuntimeReadyMs}, shutdownMs=${benchmark.shutdownToProcessExitMs}, exit=${exit.code ?? exit.signal ?? "unknown"}.`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (stdout.trim()) console.error(`Packaged app stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`Packaged app stderr:\n${stderr.trim()}`);
  if (readiness) {
    const lifecycle = Object.fromEntries(await Promise.all(
      ["before-quit", "runtime-stopped", "app-exit"].map(async (stage) => [
        stage,
        Boolean(await readJsonIfPresent(`${markerPath}.${stage}.json`)),
      ]),
    ));
    console.error("Packaged app lifecycle:", {
      mainAlive: processExists(readiness.mainPid),
      runtimeAlive: processExists(readiness.runtimePid),
      lifecycle,
      ...(process.platform !== "win32"
        ? {
            mainProcess: spawnSync(
              "ps",
              ["-o", "pid=,ppid=,state=,command=", "-p", String(readiness.mainPid)],
              { encoding: "utf8" },
            ).stdout.trim(),
          }
        : {}),
    });
  }
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
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    // Chromium can briefly retain profile WAL handles after its owning
    // process exits on Windows. Keep cleanup bounded while allowing the OS to
    // release those handles instead of turning a successful smoke into EBUSY.
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 100,
  });
}
