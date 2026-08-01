import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem, version } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";

const execFileAsync = promisify(execFile);
const reportPath = resolve(
  process.env.INERTIA_DESKTOP_BENCHMARK_REPORT
    ?? `performance-results/desktop-${process.platform}-${process.arch}.json`,
);

interface RuntimeSnapshot {
  phase: string;
  pid: number | null;
}

interface AppRun {
  electronApp: ElectronApplication;
  page: Page;
  startupMs: number;
  firstWindowMs: number;
}

async function initializeWorkspace(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src"), { recursive: true });
  await Promise.all(Array.from({ length: 120 }, async (_, index) => {
    await writeFile(
      join(workspace, "src", `module-${String(index).padStart(3, "0")}.ts`),
      `export const value = ${index};\n`,
    );
  }));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", [
    "-c",
    "user.name=Inertia Benchmark",
    "-c",
    "user.email=benchmark@inertia.local",
    "commit",
    "-qm",
    "fixture",
  ], { cwd: workspace });
  await writeFile(
    join(workspace, "src", "module-000.ts"),
    "export const value = 0;\nexport const changed = true;\n",
  );
}

function seedRuntime(dataDirectory: string, workspace: string): void {
  const store = new RuntimeStore(
    join(dataDirectory, "inertia.sqlite"),
    workspace,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Performance fixture", workspace);
  const primary = store.createConversation(project.id, "Performance primary");
  for (let index = 0; index < 600; index += 1) {
    store.createMessage(
      primary.id,
      `${index % 2 === 0 ? "Request" : "Response"} ${index}: ${"x".repeat(384)}`,
      index % 2 === 0 ? "user" : "assistant",
    );
  }
  const secondary = store.createConversation(project.id, "Performance secondary");
  for (let index = 0; index < 40; index += 1) {
    store.createMessage(
      secondary.id,
      `Secondary ${index}: ${"y".repeat(128)}`,
      index % 2 === 0 ? "user" : "assistant",
    );
  }
  store.selectConversation(primary.id);
  store.close();
}

async function launchApp(
  dataDirectory: string,
  workspace: string,
  profile: string,
): Promise<AppRun> {
  const startedAt = performance.now();
  const electronApp = await electron.launch({
    args: [".", `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: dataDirectory,
      INERTIA_WORKSPACE_DIR: workspace,
    },
  });
  const page = await electronApp.firstWindow();
  const firstWindowMs = performance.now() - startedAt;
  await page.locator('.app-shell[data-connection-status="online"]').waitFor();
  await page.getByRole("textbox", { name: "Message" }).first().waitFor();
  return {
    electronApp,
    page,
    startupMs: performance.now() - startedAt,
    firstWindowMs,
  };
}

async function runtimeSnapshot(electronApp: ElectronApplication): Promise<RuntimeSnapshot> {
  const snapshot = await electronApp.evaluate(() => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      snapshot?: () => RuntimeSnapshot;
    } | undefined;
    return runtime?.snapshot?.() ?? null;
  });
  if (!snapshot) throw new Error("The benchmark runtime snapshot is unavailable.");
  return snapshot;
}

async function processSample(electronApp: ElectronApplication) {
  const runtime = await runtimeSnapshot(electronApp);
  return await electronApp.evaluate(async (
    { app, BrowserWindow, screen },
    runtimePid,
  ) => {
    const window = BrowserWindow.getAllWindows()[0];
    const rendererPid = window?.webContents.getOSProcessId() ?? null;
    const mainMemory = await process.getProcessMemoryInfo();
    const metrics = app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      role: metric.pid === process.pid
        ? "main"
        : metric.pid === rendererPid
          ? "renderer"
          : metric.pid === runtimePid
            ? "utility-runtime"
            : metric.type.toLocaleLowerCase().includes("gpu")
              ? "gpu"
              : "electron-child",
      cpuPercent: metric.cpu.percentCPUUsage,
      idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
      workingSetKb: metric.memory.workingSetSize,
      peakWorkingSetKb: metric.memory.peakWorkingSetSize,
      privateKb: metric.memory.privateBytes,
    }));
    const display = screen.getPrimaryDisplay();
    return {
      electronVersion: process.versions.electron,
      mainPid: process.pid,
      rendererPid,
      runtimePid,
      browserWindowCount: BrowserWindow.getAllWindows().length,
      mainMemoryKb: mainMemory,
      metrics,
      gpuFeatureStatus: app.getGPUFeatureStatus(),
      gpuInfo: await app.getGPUInfo("basic"),
      display: {
        scaleFactor: display.scaleFactor,
        width: display.size.width,
        height: display.size.height,
      },
    };
  }, runtime.pid);
}

async function scrollSample(page: Page) {
  return await page.locator(".response-timeline").evaluate(async (timeline) => {
    const frameIntervals: number[] = [];
    let previous = performance.now();
    for (let index = 0; index < 120; index += 1) {
      await new Promise<void>((resolveFrame) => requestAnimationFrame((now) => {
        frameIntervals.push(now - previous);
        previous = now;
        timeline.scrollTop = index % 2 === 0 ? timeline.scrollHeight : 0;
        resolveFrame();
      }));
    }
    const ordered = [...frameIntervals].sort((left, right) => left - right);
    return {
      frames: frameIntervals.length,
      medianFrameMs: ordered[Math.floor(ordered.length / 2)] ?? 0,
      p95FrameMs: ordered[Math.floor(ordered.length * 0.95)] ?? 0,
      over25Ms: frameIntervals.filter((value) => value > 25).length,
      scrollHeight: timeline.scrollHeight,
      mountedElements: timeline.querySelectorAll("*").length,
    };
  });
}

async function closeApp(electronApp: ElectronApplication): Promise<number> {
  const startedAt = performance.now();
  await electronApp.evaluate(() => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      quit?: () => unknown;
    } | undefined;
    runtime?.quit?.();
  });
  await electronApp.close();
  return performance.now() - startedAt;
}

test("records desktop startup, process, scroll, split, terminal, and shutdown costs", async () => {
  expect(process.version).toMatch(/^v22\./u);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "inertia-desktop-benchmark-"));
  const dataDirectory = join(fixtureRoot, "data");
  const workspace = join(fixtureRoot, "workspace");
  const profile = join(fixtureRoot, "profile");
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(profile, { recursive: true }),
  ]);
  await initializeWorkspace(workspace);
  seedRuntime(dataDirectory, workspace);

  let cold: AppRun | null = null;
  let warm: AppRun | null = null;
  try {
    cold = await launchApp(dataDirectory, workspace, profile);
    const idleStart = await processSample(cold.electronApp);
    await cold.page.waitForTimeout(1_500);
    const idleEnd = await processSample(cold.electronApp);
    const scroll = await scrollSample(cold.page);

    if (!await cold.page.locator(".workspace-panel").isVisible().catch(() => false)) {
      await cold.page.getByRole("button", {
        name: "Open workspace tools",
      }).click();
    }
    const tools = cold.page.getByRole("complementary", { name: "Workspace tools" });
    const fileTreeStartedAt = performance.now();
    await tools.getByRole("tab", { name: /Files/u }).click();
    await tools.getByRole("tree", { name: "Workspace files" }).waitFor();
    const fileTreeMs = performance.now() - fileTreeStartedAt;

    const terminalStartedAt = performance.now();
    await tools.getByRole("tab", { name: "Terminal", exact: true }).click();
    await tools.locator(".terminal-panel[data-terminal-id]").waitFor();
    const terminalStartupMs = performance.now() - terminalStartedAt;

    const splitStartedAt = performance.now();
    await cold.page.getByRole("button", {
      name: "Thread actions for Performance secondary",
    }).click();
    await cold.page.getByRole("menuitem", {
      name: "Add this chat to split view",
    }).click();
    await cold.page.getByRole("main", {
      name: "Split conversation workspace",
    }).waitFor();
    const splitChatMs = performance.now() - splitStartedAt;
    const activeSample = await processSample(cold.electronApp);
    await cold.page.getByRole("button", {
      name: "Close split chat Performance secondary",
    }).click();
    const coldStartup = {
      firstWindowMs: cold.firstWindowMs,
      runtimeInteractiveMs: cold.startupMs,
    };
    const coldShutdownMs = await closeApp(cold.electronApp);
    cold = null;

    warm = await launchApp(dataDirectory, workspace, profile);
    const warmSample = await processSample(warm.electronApp);
    const warmStartup = {
      firstWindowMs: warm.firstWindowMs,
      runtimeInteractiveMs: warm.startupMs,
    };
    const warmShutdownMs = await closeApp(warm.electronApp);
    warm = null;

    const cpu = cpus();
    const report = {
      schemaVersion: 1,
      collectedAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        electron: activeSample.electronVersion,
        playwright: "bundled",
      },
      host: {
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        osVersion: version(),
        cpuModel: cpu[0]?.model?.slice(0, 120) ?? "unknown",
        logicalCpuCount: cpu.length,
        totalMemoryBytes: totalmem(),
        displayServer: process.env.XDG_SESSION_TYPE ?? null,
      },
      fixture: {
        conversations: 2,
        primaryMessages: 600,
        secondaryMessages: 40,
        workspaceFiles: 120,
        profileReuse: true,
      },
      scenarios: {
        coldStartup: {
          ...coldStartup,
          definition: "fresh Electron profile and pre-seeded runtime database; operating-system cache uncontrolled",
        },
        warmStartup: {
          ...warmStartup,
          definition: "same Electron profile and runtime database after a clean shutdown",
        },
        idle: { durationMs: 1_500, start: idleStart, end: idleEnd },
        longThreadScroll: scroll,
        fileTree: { interactiveMs: fileTreeMs },
        terminal: { startupMs: terminalStartupMs },
        splitChat: { interactiveMs: splitChatMs },
        active: activeSample,
        warm: warmSample,
        shutdown: { coldMs: coldShutdownMs, warmMs: warmShutdownMs },
      },
      limitations: [
        "Active provider streaming is covered by deterministic protocol benchmarks, not a live external provider in this desktop run.",
        "The product owns one BrowserWindow; split chat is measured instead of inventing a multi-window mode.",
        "GPU information is observational; the benchmark does not force an adapter or Chromium feature flag.",
      ],
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    expect(report.scenarios.longThreadScroll.frames).toBe(120);
    expect(report.scenarios.active.browserWindowCount).toBe(1);
    expect(report.scenarios.active.runtimePid).not.toBeNull();
    expect(report.scenarios.active.rendererPid).not.toBeNull();
    expect(report.scenarios.terminal.startupMs).toBeLessThan(30_000);
    expect(report.scenarios.shutdown.coldMs).toBeLessThan(15_000);
    expect(report.scenarios.shutdown.warmMs).toBeLessThan(15_000);
  } finally {
    if (cold) await closeApp(cold.electronApp).catch(() => undefined);
    if (warm) await closeApp(warm.electronApp).catch(() => undefined);
    await rm(fixtureRoot, {
      recursive: true,
      force: true,
      ...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 100 } : {}),
    });
  }
});
