import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
import { processExists } from "../e2e/support/app-fixture";

const execFileAsync = promisify(execFile);
const reportPath = resolve(
  process.env.INERTIA_DESKTOP_BENCHMARK_REPORT
    ?? `performance-results/desktop-${process.platform}-${process.arch}.json`,
);

// Hosted runners share virtualized CPU and display resources. Keep the exact
// 50/100ms perceived-performance targets in the report for same-host
// comparisons, while CI blocks only catastrophic regressions large enough to
// remain meaningful under transient runner contention.
const CI_STREAM_FIRST_PAINT_CATASTROPHIC_MS = 500;
const CI_STREAM_FINAL_PAINT_CATASTROPHIC_MS = 1_500;

const streamingAppServer = `
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "performance-thread";
const turnId = "performance-turn";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "performance-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
    return;
  }
  if (message.method !== "turn/start") return;
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  let index = 0;
  const timer = setInterval(() => {
    if (index === 0) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "performance-answer", delta: "STREAM_PROVIDER_DELTA_" + Date.now() + " " } });
    } else if (index < 128) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "performance-answer", delta: "chunk-" + index + "🙂 " } });
    } else {
      clearInterval(timer);
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "performance-answer", delta: " STREAM_PROVIDER_COMPLETE_" + Date.now() } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
    }
    index += 1;
  }, 8);
});
`;

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
  await Promise.all([
    writeFile(join(workspace, "app-server"), streamingAppServer, "utf8"),
    writeFile(
      join(workspace, "login"),
      [
        'if (process.argv[2] === "status") {',
        '  process.stdout.write("Logged in using ChatGPT\\n");',
        "  process.exit(0);",
        "}",
        'process.stdout.write("Sign-in complete\\n");',
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(workspace, ".git", "info", "exclude"),
      "app-server\nlogin\n",
      { encoding: "utf8", flag: "a" },
    ),
  ]);
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
      INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED: process.execPath,
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

async function streamingResponsivenessSample(
  electronApp: ElectronApplication,
  page: Page,
  dataDirectory: string,
) {
  const memoryBefore = await rendererMemorySample(
    electronApp,
    page,
    "stream-before",
  );
  const processBefore = await processSample(electronApp);
  const measurementPromise = page.evaluate(() => (
    new Promise<{
      firstProviderDeltaToPaintMs: number;
      completionToFinalPaintMs: number;
      medianVisibleGapMs: number;
      p95VisibleGapMs: number;
      visibleUpdates: number;
      visibleUpdatesPerSecond: number;
      longTasks: number;
      longTaskTotalMs: number;
      frames: number;
      droppedOrOverBudgetFrames: number;
      frameBudgetMs: number;
    }>((resolveMeasurement, rejectMeasurement) => {
      const visibleUpdates: number[] = [];
      const frameIntervals: number[] = [];
      const longTaskDurations: number[] = [];
      let lastVisibleText = "";
      let firstProviderDeltaToPaintMs: number | null = null;
      let completionToFinalPaintMs: number | null = null;
      let previousFrame = performance.now();
      let frameHandle = 0;
      let paintPending = false;
      let settled = false;
      const timeout = window.setTimeout(() => {
        stop();
        rejectMeasurement(new Error("The deterministic stream did not settle."));
      }, 15_000);
      let longTaskObserver: PerformanceObserver | null = null;

      const percentile = (values: readonly number[], fraction: number): number => {
        if (values.length === 0) return 0;
        const ordered = [...values].sort((left, right) => left - right);
        return ordered[Math.min(
          ordered.length - 1,
          Math.floor(ordered.length * fraction),
        )]!;
      };
      const frame = (now: number): void => {
        frameIntervals.push(now - previousFrame);
        previousFrame = now;
        if (!settled) frameHandle = window.requestAnimationFrame(frame);
      };
      const stop = (): void => {
        settled = true;
        window.clearTimeout(timeout);
        window.cancelAnimationFrame(frameHandle);
        mutationObserver.disconnect();
        longTaskObserver?.disconnect();
      };
      const finish = (): void => {
        if (
          settled
          || firstProviderDeltaToPaintMs === null
          || completionToFinalPaintMs === null
        ) return;
        stop();
        const gaps = visibleUpdates.slice(1).map(
          (time, index) => time - visibleUpdates[index]!,
        );
        const stableFrames = frameIntervals.filter((value) => value > 0 && value < 50);
        const observedFrameMs = percentile(stableFrames, 0.5) || 16.667;
        const frameBudgetMs = Math.min(25, Math.max(10, observedFrameMs * 1.75));
        const durationMs = Math.max(
          1,
          (visibleUpdates.at(-1) ?? 0) - (visibleUpdates[0] ?? 0),
        );
        resolveMeasurement({
          firstProviderDeltaToPaintMs,
          completionToFinalPaintMs,
          medianVisibleGapMs: percentile(gaps, 0.5),
          p95VisibleGapMs: percentile(gaps, 0.95),
          visibleUpdates: visibleUpdates.length,
          visibleUpdatesPerSecond: visibleUpdates.length / (durationMs / 1_000),
          longTasks: longTaskDurations.length,
          longTaskTotalMs: longTaskDurations.reduce((sum, value) => sum + value, 0),
          frames: frameIntervals.length,
          droppedOrOverBudgetFrames: frameIntervals.filter(
            (value) => value > frameBudgetMs,
          ).length,
          frameBudgetMs,
        });
      };
      const samplePaint = (): void => {
        paintPending = false;
        const live = document.querySelector<HTMLElement>(
          '[data-stream-renderer="plain-text"]',
        );
        const finalAnswer = document.querySelector<HTMLElement>(
          '[data-answer-phase="persisted"] .response-markdown',
        );
        const visibleText = live?.textContent ?? finalAnswer?.textContent ?? "";
        if (live && visibleText && visibleText !== lastVisibleText) {
          lastVisibleText = visibleText;
          visibleUpdates.push(performance.now());
        }
        const firstMarker = visibleText.match(/STREAM_PROVIDER_DELTA_(\d+)/u);
        if (firstMarker && firstProviderDeltaToPaintMs === null) {
          firstProviderDeltaToPaintMs = Date.now() - Number(firstMarker[1]);
        }
        const completionMarker = finalAnswer?.textContent?.match(
          /STREAM_PROVIDER_COMPLETE_(\d+)/u,
        );
        if (completionMarker && completionToFinalPaintMs === null) {
          completionToFinalPaintMs = Date.now() - Number(completionMarker[1]);
        }
        finish();
      };
      const mutationObserver = new MutationObserver(() => {
        if (paintPending || settled) return;
        paintPending = true;
        window.requestAnimationFrame(samplePaint);
      });
      mutationObserver.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          longTaskDurations.push(...list.getEntries().map(({ duration }) => duration));
        });
        longTaskObserver.observe({ entryTypes: ["longtask"] });
      } catch {
        longTaskObserver = null;
      }
      frameHandle = window.requestAnimationFrame(frame);
    })
  ));

  const composer = page.getByRole("region", { name: "Message composer" });
  await composer.getByRole("textbox", { name: "Message" })
    .fill("Run the deterministic streaming responsiveness fixture.");
  await composer.getByRole("button", { name: "Send message" }).click();
  await page.locator('[data-stream-renderer="plain-text"]').waitFor({
    timeout: 10_000,
  });
  const memoryDuring = await rendererMemorySample(
    electronApp,
    page,
    "stream-during",
  );
  const processDuring = await processSample(electronApp);
  const visible = await measurementPromise;
  const memoryAfter = await rendererMemorySample(
    electronApp,
    page,
    "stream-after",
  );
  const processAfter = await processSample(electronApp);
  const walBytes = await stat(join(dataDirectory, "inertia.sqlite-wal"))
    .then(({ size }) => size)
    .catch(() => 0);
  return {
    ...visible,
    walBytes,
    memory: {
      before: memoryBefore,
      during: memoryDuring,
      after: memoryAfter,
    },
    processes: {
      before: processBefore.metrics,
      during: processDuring.metrics,
      after: processAfter.metrics,
    },
  };
}

async function rendererMemorySample(
  electronApp: ElectronApplication,
  page: Page,
  phase: string,
) {
  const session = await page.context().newCDPSession(page);
  let heap: { usedSize: number; totalSize: number };
  try {
    await session.send("HeapProfiler.collectGarbage");
    await page.evaluate(async () => {
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolveFrame());
      }));
    });
    heap = await session.send("Runtime.getHeapUsage");
  } finally {
    await session.detach();
  }
  const processMemory = await electronApp.evaluate(({ app, BrowserWindow }) => {
    const rendererPid = BrowserWindow.getAllWindows()[0]
      ?.webContents.getOSProcessId() ?? null;
    const metric = app.getAppMetrics().find(({ pid }) => pid === rendererPid);
    return {
      rendererPid,
      workingSetKb: metric?.memory.workingSetSize ?? null,
      peakWorkingSetKb: metric?.memory.peakWorkingSetSize ?? null,
      privateKb: metric?.memory.privateBytes ?? null,
    };
  });
  return {
    phase,
    collectedAt: new Date().toISOString(),
    usedJsHeapBytes: heap.usedSize,
    totalJsHeapBytes: heap.totalSize,
    ...processMemory,
  };
}

async function openWorkspaceTools(page: Page): Promise<void> {
  if (await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    return;
  }
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await page.locator(".workspace-panel").waitFor();
}

async function openSplitChat(page: Page): Promise<void> {
  await page.getByRole("button", {
    name: "Thread actions for Performance secondary",
  }).click();
  await page.getByRole("menuitem", {
    name: "Add this chat to split view",
  }).click();
  await page.getByRole("main", {
    name: "Split conversation workspace",
  }).waitFor();
}

async function closeSplitChat(page: Page): Promise<void> {
  await page.getByRole("button", {
    name: "Close split chat Performance secondary",
  }).click();
  await expect(page.getByRole("main", {
    name: "Split conversation workspace",
  })).toHaveCount(0);
}

async function openAndCloseToolCycle(page: Page): Promise<void> {
  await openWorkspaceTools(page);
  const tools = page.getByRole("complementary", { name: "Workspace tools" });
  await tools.getByRole("tab", { name: /Files/u }).click();
  await tools.getByRole("tree", { name: "Workspace files" }).waitFor();
  await tools.getByRole("tab", { name: "Terminal", exact: true }).click();
  await tools.locator(".terminal-panel[data-terminal-id]").waitFor();
  await tools.getByRole("button", { name: "Close terminal" }).first().click();
  await expect(tools.locator(".terminal-panel[data-terminal-id]")).toHaveCount(0);
}

interface RendererInteractionMeasurement {
  triggerSelector?: string;
  targetSelector: string;
  shortcut?: "command-palette";
}

async function rendererInteractionMeasurement(
  page: Page,
  measurement: RendererInteractionMeasurement,
): Promise<number> {
  return page.evaluate(({ triggerSelector, targetSelector, shortcut }) => (
    new Promise<number>((resolveMeasurement, rejectMeasurement) => {
      const startedAt = performance.now();
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        rejectMeasurement(new Error(
          `The interaction target did not appear: ${targetSelector}`,
        ));
      }, 5_000);
      const finishIfVisible = (): boolean => {
        const target = document.querySelector<HTMLElement>(targetSelector);
        if (!target) return false;
        observer.disconnect();
        window.clearTimeout(timeout);
        resolveMeasurement(performance.now() - startedAt);
        return true;
      };
      const observer = new MutationObserver(finishIfVisible);
      observer.observe(document.body, { childList: true, subtree: true });
      if (shortcut === "command-palette") {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }));
      } else {
        const trigger = triggerSelector
          ? document.querySelector<HTMLButtonElement>(triggerSelector)
          : null;
        if (!trigger) {
          observer.disconnect();
          window.clearTimeout(timeout);
          rejectMeasurement(new Error(
            `The interaction trigger is unavailable: ${triggerSelector ?? "missing"}`,
          ));
          return;
        }
        trigger.click();
      }
      finishIfVisible();
    })
  ), measurement);
}

async function coldIntentDialogMeasurement(page: Page): Promise<number> {
  const elapsed = await rendererInteractionMeasurement(page, {
    triggerSelector: 'button[aria-label="Launch two chats"]',
    targetSelector: '.multi-spawn-dialog[role="dialog"]',
  });
  await page.getByRole("button", { name: "Close multi-spawn" }).click();
  return elapsed;
}

async function prefetchedOverlayMeasurements(page: Page): Promise<{
  activityFirstOpenMs: number;
  activityWarmReopenMs: number;
  commandPaletteFirstOpenMs: number;
}> {
  const activityFirstOpenMs = await rendererInteractionMeasurement(page, {
    triggerSelector: 'button[aria-label^="Open runs"]',
    targetSelector: '.activity-center[role="dialog"]',
  });
  await page.getByRole("button", { name: "Close runs" }).click();

  const activityWarmReopenMs = await rendererInteractionMeasurement(page, {
    triggerSelector: 'button[aria-label^="Open runs"]',
    targetSelector: '.activity-center[role="dialog"]',
  });
  await page.getByRole("button", { name: "Close runs" }).click();

  const commandPaletteFirstOpenMs = await rendererInteractionMeasurement(page, {
    shortcut: "command-palette",
    targetSelector: '.command-palette[role="dialog"]',
  });
  await page.getByRole("button", { name: "Close search" }).click();
  return {
    activityFirstOpenMs,
    activityWarmReopenMs,
    commandPaletteFirstOpenMs,
  };
}

async function closeApp(
  electronApp: ElectronApplication,
  runtimePid: number | null,
): Promise<number> {
  const startedAt = performance.now();
  await electronApp.evaluate(() => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      quit?: () => unknown;
    } | undefined;
    runtime?.quit?.();
  });
  await electronApp.close();
  if (runtimePid) {
    await expect.poll(
      () => processExists(runtimePid),
      { timeout: 5_000 },
    ).toBe(false);
  }
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
    const coldIntentDialogMs = await coldIntentDialogMeasurement(cold.page);
    const idleStart = await processSample(cold.electronApp);
    await cold.page.waitForTimeout(1_500);
    const idleEnd = await processSample(cold.electronApp);
    const prefetchedOverlays = await prefetchedOverlayMeasurements(cold.page);
    const memoryBaseline = await rendererMemorySample(
      cold.electronApp,
      cold.page,
      "idle-baseline",
    );
    const scroll = await scrollSample(cold.page);
    const streamingResponsiveness = await streamingResponsivenessSample(
      cold.electronApp,
      cold.page,
      dataDirectory,
    );

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
    await openSplitChat(cold.page);
    const splitChatMs = performance.now() - splitStartedAt;
    const activeSample = await processSample(cold.electronApp);
    const memoryActive = await rendererMemorySample(
      cold.electronApp,
      cold.page,
      "long-thread-files-terminal-split-active",
    );

    await closeSplitChat(cold.page);
    await cold.page.getByRole("button", {
      name: "Close workspace tools",
    }).first().click();
    const memoryPanelsHidden = await rendererMemorySample(
      cold.electronApp,
      cold.page,
      "split-closed-tools-hidden",
    );

    await openWorkspaceTools(cold.page);
    await cold.page.getByRole("complementary", { name: "Workspace tools" })
      .getByRole("button", { name: "Close terminal" })
      .first()
      .click();
    const memoryPostClose = await rendererMemorySample(
      cold.electronApp,
      cold.page,
      "split-and-terminal-closed",
    );

    const repeatedOpenClose: Awaited<ReturnType<typeof rendererMemorySample>>[] = [];
    for (let iteration = 0; iteration < 8; iteration += 1) {
      await openAndCloseToolCycle(cold.page);
      await openSplitChat(cold.page);
      await closeSplitChat(cold.page);
      repeatedOpenClose.push(await rendererMemorySample(
        cold.electronApp,
        cold.page,
        `open-close-${iteration + 1}`,
      ));
    }

    const soakBefore = await rendererMemorySample(
      cold.electronApp,
      cold.page,
      "soak-before",
    );
    const soakScrollSamples = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      soakScrollSamples.push(await scrollSample(cold.page));
      await openAndCloseToolCycle(cold.page);
    }
    const soakAfter = await rendererMemorySample(
      cold.electronApp,
      cold.page,
      "soak-after-600-scroll-frames-and-tool-cycles",
    );
    const coldStartup = {
      firstWindowMs: cold.firstWindowMs,
      runtimeInteractiveMs: cold.startupMs,
    };
    const coldShutdownMs = await closeApp(
      cold.electronApp,
      activeSample.runtimePid,
    );
    cold = null;

    warm = await launchApp(dataDirectory, workspace, profile);
    const warmSample = await processSample(warm.electronApp);
    const warmStartup = {
      firstWindowMs: warm.firstWindowMs,
      runtimeInteractiveMs: warm.startupMs,
    };
    const warmShutdownMs = await closeApp(
      warm.electronApp,
      warmSample.runtimePid,
    );
    warm = null;

    const cpu = cpus();
    const sessionType = process.env.XDG_SESSION_TYPE?.trim().toLocaleLowerCase()
      || null;
    const displayPresent = Boolean(process.env.DISPLAY);
    const waylandPresent = Boolean(process.env.WAYLAND_DISPLAY);
    const displayServer = sessionType === "x11" || sessionType === "wayland"
      ? sessionType
      : waylandPresent
        ? "wayland"
        : displayPresent
          ? "x11"
          : "none";
      const report = {
      schemaVersion: 2,
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
        displayServer,
        sessionType,
        displayPresent,
        waylandPresent,
      },
      fixture: {
        conversations: 2,
        primaryMessages: 600,
        secondaryMessages: 40,
        workspaceFiles: 120,
        profileReuse: true,
        providerMode: "deterministic-codex-app-server",
      },
        scenarios: {
        coldStartup: {
          ...coldStartup,
          definition: "fresh Electron profile and pre-seeded runtime database in provider-disabled NODE_ENV=test; operating-system cache uncontrolled",
        },
        warmStartup: {
          ...warmStartup,
          definition: "same Electron profile and runtime database after the prior utility-runtime PID was confirmed stopped; providers remain disabled in NODE_ENV=test",
        },
        idle: { durationMs: 1_500, start: idleStart, end: idleEnd },
        longThreadScroll: scroll,
          streamingResponsiveness: {
            ...streamingResponsiveness,
            stableTargets: {
              firstProviderDeltaToPaintMs: 50,
              p95VisibleGapMs: 100,
              firstPaintMet:
                streamingResponsiveness.firstProviderDeltaToPaintMs < 50,
              visibleGapMet:
                streamingResponsiveness.p95VisibleGapMs < 100,
            },
          },
        firstOpenLatency: {
          coldIntentDialogMs,
          ...prefetchedOverlays,
        },
        fileTree: { interactiveMs: fileTreeMs },
        terminal: { startupMs: terminalStartupMs },
        splitChat: { interactiveMs: splitChatMs },
        rendererMemory: {
          baseline: memoryBaseline,
          active: memoryActive,
          panelsHidden: memoryPanelsHidden,
          postClose: memoryPostClose,
          postCloseReclaimedJsHeapBytes: Math.max(
            0,
            memoryActive.usedJsHeapBytes - memoryPostClose.usedJsHeapBytes,
          ),
          repeatedOpenClose,
          soak: {
            iterations: 5,
            scrollFrames: soakScrollSamples.reduce(
              (sum, sample) => sum + sample.frames,
              0,
            ),
            before: soakBefore,
            after: soakAfter,
            retainedJsHeapBytes: Math.max(
              0,
              soakAfter.usedJsHeapBytes - soakBefore.usedJsHeapBytes,
            ),
          },
        },
        active: activeSample,
        warm: warmSample,
        shutdown: { coldMs: coldShutdownMs, warmMs: warmShutdownMs },
      },
      limitations: [
        "Desktop streaming uses a deterministic local Codex app-server fixture; it exercises the production provider, utility-runtime, SQLite, WebSocket, React, and paint path without network variance.",
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
    expect(report.scenarios.streamingResponsiveness.firstProviderDeltaToPaintMs)
      .toBeLessThan(CI_STREAM_FIRST_PAINT_CATASTROPHIC_MS);
    expect(report.scenarios.streamingResponsiveness.p95VisibleGapMs)
      .toBeLessThan(175);
    expect(report.scenarios.streamingResponsiveness.visibleUpdates)
      .toBeGreaterThan(4);
    expect(report.scenarios.streamingResponsiveness.walBytes)
      .toBeGreaterThan(0);
    expect(report.scenarios.streamingResponsiveness.completionToFinalPaintMs)
      .toBeLessThan(CI_STREAM_FINAL_PAINT_CATASTROPHIC_MS);
    expect(report.scenarios.streamingResponsiveness.longTaskTotalMs)
      .toBeLessThan(2_000);
    expect(report.scenarios.streamingResponsiveness.droppedOrOverBudgetFrames)
      .toBeLessThan(report.scenarios.streamingResponsiveness.frames);
    expect(report.scenarios.streamingResponsiveness.memory.after.usedJsHeapBytes)
      .toBeLessThanOrEqual(
        report.scenarios.streamingResponsiveness.memory.before.usedJsHeapBytes
          + 32 * 1024 * 1024,
      );
    expect(report.scenarios.firstOpenLatency.coldIntentDialogMs)
      .toBeLessThan(5_000);
    expect(report.scenarios.firstOpenLatency.activityFirstOpenMs)
      .toBeLessThan(2_000);
    expect(report.scenarios.firstOpenLatency.activityWarmReopenMs)
      .toBeLessThan(1_000);
    expect(report.scenarios.firstOpenLatency.commandPaletteFirstOpenMs)
      .toBeLessThan(2_000);
    expect(["none", "wayland", "x11"]).toContain(report.host.displayServer);
    expect(report.host.displayPresent).toBe(Boolean(process.env.DISPLAY));
    expect(report.host.waylandPresent).toBe(Boolean(process.env.WAYLAND_DISPLAY));
    expect(report.scenarios.active.browserWindowCount).toBe(1);
    expect(report.scenarios.active.runtimePid).not.toBeNull();
    expect(report.scenarios.active.rendererPid).not.toBeNull();
    expect(report.scenarios.terminal.startupMs).toBeLessThan(30_000);
    expect(report.scenarios.rendererMemory.postClose.usedJsHeapBytes)
      .toBeLessThanOrEqual(
        report.scenarios.rendererMemory.active.usedJsHeapBytes
          + 32 * 1024 * 1024,
      );
    expect(report.scenarios.rendererMemory.repeatedOpenClose).toHaveLength(8);
    const firstOpenClose = report.scenarios.rendererMemory.repeatedOpenClose[0]!;
    const lastOpenClose = report.scenarios.rendererMemory.repeatedOpenClose.at(-1)!;
    expect(lastOpenClose.usedJsHeapBytes).toBeLessThanOrEqual(
      firstOpenClose.usedJsHeapBytes + 16 * 1024 * 1024,
    );
    if (
      firstOpenClose.workingSetKb !== null
      && lastOpenClose.workingSetKb !== null
    ) {
      expect(lastOpenClose.workingSetKb).toBeLessThanOrEqual(
        firstOpenClose.workingSetKb + 64 * 1024,
      );
    }
    expect(report.scenarios.rendererMemory.soak.scrollFrames).toBe(600);
    expect(report.scenarios.rendererMemory.soak.after.usedJsHeapBytes)
      .toBeLessThanOrEqual(
        report.scenarios.rendererMemory.soak.before.usedJsHeapBytes
          + 32 * 1024 * 1024,
      );
    expect(report.scenarios.shutdown.coldMs).toBeLessThan(15_000);
    expect(report.scenarios.shutdown.warmMs).toBeLessThan(15_000);
  } finally {
    if (cold) {
      const runtimePid = (await runtimeSnapshot(cold.electronApp).catch(() => null))?.pid ?? null;
      await closeApp(cold.electronApp, runtimePid).catch(() => undefined);
    }
    if (warm) {
      const runtimePid = (await runtimeSnapshot(warm.electronApp).catch(() => null))?.pid ?? null;
      await closeApp(warm.electronApp, runtimePid).catch(() => undefined);
    }
    await rm(fixtureRoot, {
      recursive: true,
      force: true,
      ...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 100 } : {}),
    });
  }
});
