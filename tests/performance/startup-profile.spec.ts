import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, loadavg, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync, deflateRawSync } from "node:zlib";

import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { quitElectronAppBounded, processExists, waitForRuntimeProcessExit } from "../e2e/support/electron-app-lifecycle";
import { summarizeCpuProfileFile, type CpuProfileSummary } from "./cpuprofile-summary";
import { initializeStartupWorkspace, seedStartupDatabase, type StartupSeedSummary } from "./startup-profile-seed";

type Mode = "playwright" | "spawn" | "trace";
const MODE = (process.env.INERTIA_STARTUP_MODE ?? "playwright") as Mode;
const RUNS = Number(process.env.INERTIA_STARTUP_RUNS ?? 7);
const LONG_TURNS = Number(process.env.INERTIA_STARTUP_LONG_TURNS ?? 300);
const MAIN_CPU_PROFILE = process.env.INERTIA_STARTUP_MAIN_CPU_PROFILE === "1";
const WORKER_CPU_PROFILE = process.env.INERTIA_STARTUP_WORKER_CPU_PROFILE === "1";
const RENDERER_CPU_PROFILE = process.env.INERTIA_STARTUP_RENDERER_CPU_PROFILE === "1";
const LABEL = process.env.INERTIA_STARTUP_LABEL ?? "main";
const OUTPUT_DIRECTORY = resolve(process.env.INERTIA_STARTUP_OUTPUT_DIR ?? "performance-results/startup");
const OBSERVER_SCRIPT = resolve("tests/performance/startup-observer.js");
const MARKS_TIMEOUT_MS = 30_000;
const TRACE_SECONDS = 12;
const LOAD_CEILING = Number(process.env.INERTIA_STARTUP_LOAD_CEILING ?? 4);
const LOAD_WAIT_MS = Number(process.env.INERTIA_STARTUP_LOAD_WAIT_MS ?? 60_000);

async function waitForQuietMachine(): Promise<number> {
  const startedAt = Date.now();
  while (loadavg()[0]! > LOAD_CEILING && Date.now() - startedAt < LOAD_WAIT_MS) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  return Date.now() - startedAt;
}
const TRACE_CATEGORIES = [
  "toplevel",
  "blink.user_timing",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "v8.execute",
  "v8",
  "loading",
  "navigation",
  "disabled-by-default-v8.cpu_profiler",
].join(",");

interface LaunchRecord {
  mode: Mode;
  round: number;
  temperature: "cold" | "warm";
  launchRequestedAt: number;
  loadBefore: number[];
  loadAfter: number[];
  harness: Record<string, number>;
  mainMarks: unknown;
  workerMarks: unknown;
  renderer: unknown;
  appMetrics: unknown;
  welcome: { bytes: number; gzipBytes: number; deflateRawBytes: number; receivedAt: number } | null;
  frames: Array<{ at: number; bytes: number; type: string | null }>;
  cpuProfiles: Record<string, CpuProfileSummary | string>;
  shutdown: string;
}

function electronExecutable(): string {
  return createRequire(import.meta.url)("electron") as string;
}

async function waitForFiles(directory: string, prefixes: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  const found: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const prefix of prefixes) {
      if (found[prefix]) continue;
      const name = names.find((candidate) => candidate.startsWith(prefix) && candidate.endsWith(".json"));
      if (!name) continue;
      try {
        found[prefix] = JSON.parse(await readFile(join(directory, name), "utf8"));
      } catch {
        continue;
      }
    }
    if (prefixes.every((prefix) => found[prefix])) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return found;
}

async function removeMarks(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => name.startsWith("startup-marks-"))
    .map((name) => rm(join(directory, name), { force: true })));
}

async function latestCpuProfile(directory: string): Promise<string | null> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".cpuprofile"));
  let latest: { path: string; mtime: number } | null = null;
  for (const name of names) {
    const path = join(directory, name);
    const { mtimeMs } = await stat(path);
    if (!latest || mtimeMs > latest.mtime) latest = { path, mtime: mtimeMs };
  }
  return latest?.path ?? null;
}

function welcomeFrame(payload: string | Buffer, receivedAt: number) {
  const text = typeof payload === "string" ? payload : payload.toString("utf8");
  if (!text.startsWith('{"type":"server.welcome"')) return null;
  const buffer = Buffer.from(text, "utf8");
  return {
    bytes: buffer.byteLength,
    gzipBytes: gzipSync(buffer).byteLength,
    deflateRawBytes: deflateRawSync(buffer).byteLength,
    receivedAt,
  };
}

async function collectRendererState(page: Page): Promise<unknown> {
  await page.waitForFunction(() => Reflect.get(globalThis, "__inertiaStartupObserver")?.done === true, null, { timeout: 30_000 })
    .catch(() => undefined);
  return await page.evaluate(() => ({
    observer: Reflect.get(globalThis, "__inertiaStartupObserver") ?? null,
    navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
    paint: performance.getEntriesByType("paint").map((entry) => entry.toJSON()),
    resources: performance.getEntriesByType("resource").map((entry) => {
      const resource = entry as PerformanceResourceTiming;
      return {
        name: resource.name,
        startTime: resource.startTime,
        responseEnd: resource.responseEnd,
        duration: resource.duration,
        decodedBodySize: resource.decodedBodySize,
        initiatorType: resource.initiatorType,
      };
    }),
    timeOrigin: performance.timeOrigin,
  }));
}

async function appMetrics(electronApp: ElectronApplication): Promise<unknown> {
  return await electronApp.evaluate(({ app }) => ({
    mainCreationTime: process.getCreationTime(),
    mainTimeOrigin: performance.timeOrigin,
    runtime: (Reflect.get(globalThis, "__inertiaTestRuntime") as { snapshot?: () => unknown } | undefined)?.snapshot?.() ?? null,
    metrics: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      creationTime: metric.creationTime,
      serviceName: metric.serviceName ?? null,
      name: metric.name ?? null,
      workingSetKb: metric.memory.workingSetSize,
    })),
  }));
}

interface Fixture {
  root: string;
  template: string;
  workspaces: string[];
  providerBin: string;
  seed: StartupSeedSummary;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "inertia-startup-profile-"));
  const template = join(root, "template-data");
  const providerBin = join(root, "provider-bin");
  const workspaces = [join(root, "workspace-a"), join(root, "workspace-b"), join(root, "workspace-c")];
  await Promise.all([mkdir(template, { recursive: true }), mkdir(providerBin, { recursive: true })]);
  for (const [index, workspace] of workspaces.entries()) await initializeStartupWorkspace(workspace, `project${index}`);
  const seed = seedStartupDatabase(template, workspaces, {
    longChatTurns: LONG_TURNS,
    projects: workspaces.length,
    shortChatsPerProject: 8,
    shortChatMessages: 20,
  });
  return { root, template, workspaces, providerBin, seed };
}

function launchEnvironment(fixture: Fixture, dataDirectory: string, profileDirectory: string): Record<string, string> {
  const mainProfileDirectory = join(profileDirectory, "..", `${profileDirectory.split("/").at(-1)}-main-cpu`);
  const workerProfileDirectory = join(profileDirectory, "..", `${profileDirectory.split("/").at(-1)}-worker-cpu`);
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return {
    ...inherited,
    NODE_ENV: "test",
    INERTIA_DATA_DIR: dataDirectory,
    INERTIA_WORKSPACE_DIR: fixture.workspaces[0]!,
    INERTIA_TEST_PROVIDER_BIN_DIR: fixture.providerBin,
    INERTIA_STARTUP_OBSERVER_SCRIPT: OBSERVER_SCRIPT,
    ...(MAIN_CPU_PROFILE ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${mainProfileDirectory}` } : {}),
    ...(WORKER_CPU_PROFILE ? { INERTIA_STARTUP_WORKER_CPU_PROFILE_DIR: workerProfileDirectory } : {}),
  };
}

async function summarizeProfiles(profileDirectory: string, record: LaunchRecord): Promise<void> {
  const base = profileDirectory.split("/").at(-1)!;
  for (const [kind, enabled] of [["main", MAIN_CPU_PROFILE], ["worker", WORKER_CPU_PROFILE]] as const) {
    if (!enabled) continue;
    const directory = join(profileDirectory, "..", `${base}-${kind}-cpu`);
    const path = await latestCpuProfile(directory);
    if (!path) {
      record.cpuProfiles[kind] = "missing";
      continue;
    }
    const kept = join(OUTPUT_DIRECTORY, `${LABEL}-${record.temperature}-r${record.round}-${kind}.cpuprofile`);
    await cp(path, kept);
    record.cpuProfiles[`${kind}Path`] = kept;
    record.cpuProfiles[kind] = await summarizeCpuProfileFile(path, { windowMs: kind === "main" ? (record.harness.composerMs ?? 4_000) + 500 : 6_000 });
  }
}

async function launchWithPlaywright(fixture: Fixture, dataDirectory: string, profileDirectory: string, record: LaunchRecord, profileRenderer: boolean): Promise<void> {
  record.launchRequestedAt = Date.now();
  const electronApp = await electron.launch({
    args: [".", `--user-data-dir=${profileDirectory}`],
    env: launchEnvironment(fixture, dataDirectory, profileDirectory),
    timeout: 30_000,
  });
  const at = (): number => Date.now() - record.launchRequestedAt;
  record.harness.launchResolvedMs = at();
  let runtimePid: number | null = null;
  try {
    await electronApp.context().addInitScript({ path: OBSERVER_SCRIPT });
    const page = await electronApp.firstWindow();
    record.harness.firstWindowMs = at();
    page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
      const receivedAt = Date.now();
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      if (record.frames.length < 64) {
        record.frames.push({ at: receivedAt - record.launchRequestedAt, bytes: Buffer.byteLength(text), type: /^\{"type":"([^"]+)"/u.exec(text.slice(0, 64))?.[1] ?? null });
      }
      record.welcome ??= welcomeFrame(text, receivedAt - record.launchRequestedAt);
    }));
    await page.locator('.app-shell[data-connection-status="online"]').waitFor({ timeout: 60_000 });
    record.harness.onlineMs = at();
    await page.getByRole("textbox", { name: "Message" }).first().waitFor({ timeout: 30_000 });
    record.harness.composerMs = at();
    await page.locator(".message-scroll .response-virtual-item").first().waitFor({ timeout: 30_000 });
    record.harness.transcriptRowMs = at();
    record.renderer = await collectRendererState(page);
    record.appMetrics = await appMetrics(electronApp);
    runtimePid = (record.appMetrics as { runtime?: { pid?: number } }).runtime?.pid ?? null;
    const marks = await waitForFiles(dataDirectory, ["startup-marks-main-", "startup-marks-worker-"], MARKS_TIMEOUT_MS);
    record.mainMarks = marks["startup-marks-main-"] ?? null;
    record.workerMarks = marks["startup-marks-worker-"] ?? null;
    if (profileRenderer) await profileRendererReload(page, record);
  } finally {
    const quit = await quitElectronAppBounded(electronApp, () => electronApp.evaluate(() => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as { quit?: () => unknown } | undefined;
      return runtime?.quit?.() ?? null;
    }));
    record.shutdown = JSON.stringify(quit).slice(0, 200);
    if (runtimePid !== null) await waitForRuntimeProcessExit(runtimePid);
  }
}

async function profileRendererReload(page: Page, record: LaunchRecord): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 200 });
  const reloadStartedAt = Date.now();
  await session.send("Profiler.start");
  await page.reload();
  await page.getByRole("textbox", { name: "Message" }).first().waitFor({ timeout: 30_000 });
  await page.locator(".message-scroll .response-virtual-item").first().waitFor({ timeout: 30_000 });
  const reloadComposerMs = Date.now() - reloadStartedAt;
  const reloadRenderer = await collectRendererState(page);
  const { profile } = await session.send("Profiler.stop");
  const path = join(OUTPUT_DIRECTORY, `${LABEL}-renderer-reload.cpuprofile`);
  await writeFile(path, JSON.stringify(profile));
  record.cpuProfiles.rendererReloadPath = path;
  record.cpuProfiles.rendererReload = await summarizeCpuProfileFile(path, { windowMs: reloadComposerMs + 500 });
  record.harness.reloadComposerMs = reloadComposerMs;
  (record as unknown as { reloadRenderer: unknown }).reloadRenderer = reloadRenderer;
  await session.detach();
}

async function launchWithSpawn(fixture: Fixture, dataDirectory: string, profileDirectory: string, record: LaunchRecord, traceFile: string | null): Promise<void> {
  const args = [".", `--user-data-dir=${profileDirectory}`];
  if (traceFile) {
    args.push(`--trace-startup=${TRACE_CATEGORIES}`, `--trace-startup-file=${traceFile}`, `--trace-startup-duration=${TRACE_SECONDS}`);
  }
  record.launchRequestedAt = Date.now();
  const child: ChildProcess = spawn(electronExecutable(), args, {
    env: launchEnvironment(fixture, dataDirectory, profileDirectory),
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000); });
  const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  let runtimePid: number | null = null;
  try {
    const marks = await waitForFiles(dataDirectory, ["startup-marks-main-", "startup-marks-worker-"], MARKS_TIMEOUT_MS + 15_000);
    record.mainMarks = marks["startup-marks-main-"] ?? null;
    record.workerMarks = marks["startup-marks-worker-"] ?? null;
    runtimePid = (record.workerMarks as { pid?: number } | null)?.pid ?? null;
    if (!record.mainMarks || !record.workerMarks) throw new Error(`Startup marks were not written. stderr: ${stderr}`);
    if (traceFile) {
      const deadline = Date.now() + (TRACE_SECONDS + 20) * 1_000;
      while (Date.now() < deadline && !(await stat(traceFile).then((value) => value.size > 0).catch(() => false))) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
  } finally {
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((resolveWait) => setTimeout(() => resolveWait("timeout"), 20_000))]);
    if (code === "timeout") {
      child.kill("SIGKILL");
      record.shutdown = "sigterm-timeout";
    } else {
      record.shutdown = `exit:${code}`;
    }
    if (runtimePid !== null) {
      await waitForRuntimeProcessExit(runtimePid).catch(() => undefined);
      if (processExists(runtimePid)) record.shutdown += ":runtime-still-running";
    }
  }
}

test("profiles startup from launch to a usable chat", async () => {
  expect(process.version).toMatch(/^v22\./u);
  test.setTimeout(RUNS * 2 * 120_000 + 120_000);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const fixture = await createFixture();
  const templateDatabase = await stat(join(fixture.template, "inertia.sqlite"));
  const records: LaunchRecord[] = [];
  try {
    for (let round = 1; round <= RUNS; round += 1) {
      const profileDirectory = join(fixture.root, `profile-${round}`);
      const dataDirectory = join(fixture.root, `data-${round}`);
      await cp(fixture.template, dataDirectory, { recursive: true });
      for (const temperature of ["cold", "warm"] as const) {
        await removeMarks(dataDirectory);
        const quietWaitMs = await waitForQuietMachine();
        const record: LaunchRecord = {
          mode: MODE, round, temperature, launchRequestedAt: 0,
          loadBefore: loadavg(), loadAfter: [], harness: {}, mainMarks: null, workerMarks: null,
          renderer: null, appMetrics: null, welcome: null, frames: [], cpuProfiles: {}, shutdown: "",
        };
        record.harness.quietWaitMs = quietWaitMs;
        if (MODE === "playwright") {
          await launchWithPlaywright(fixture, dataDirectory, profileDirectory, record, RENDERER_CPU_PROFILE && round === RUNS && temperature === "warm");
        } else {
          const traceFile = MODE === "trace" ? join(OUTPUT_DIRECTORY, `${LABEL}-${temperature}-r${round}-startup-trace.json`) : null;
          await launchWithSpawn(fixture, dataDirectory, profileDirectory, record, traceFile);
          if (traceFile) record.cpuProfiles.tracePath = traceFile;
        }
        record.loadAfter = loadavg();
        await summarizeProfiles(profileDirectory, record);
        records.push(record);
        await writeFile(join(OUTPUT_DIRECTORY, `${LABEL}-${MODE}-${LONG_TURNS}.json`), JSON.stringify({
          label: LABEL,
          mode: MODE,
          runs: RUNS,
          host: { platform: process.platform, arch: process.arch, release: release(), cpus: cpus().length, cpuModel: cpus()[0]?.model, totalMemoryBytes: totalmem() },
          seed: fixture.seed,
          templateDatabaseBytes: templateDatabase.size,
          records,
        }, null, 1));
      }
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 3 });
  }
  expect(records.length).toBe(RUNS * 2);
});
