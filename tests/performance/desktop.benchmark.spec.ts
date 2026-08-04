import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const CI_STREAM_VISIBLE_GAP_CATASTROPHIC_MS = 500;
const CI_STREAM_FINAL_PAINT_CATASTROPHIC_MS = 1_500;
const CI_STREAM_LONG_TASK_CATASTROPHIC_MS = 2_000;

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

interface StreamingTraceMarker {
  stage: string;
  monotonicMs?: number;
  wallTimeMs: number;
}

function stageAttribution(
  runtime: readonly StreamingTraceMarker[],
  renderer: readonly StreamingTraceMarker[],
) {
  const markers = [...runtime, ...renderer]
    .sort((left, right) => left.wallTimeMs - right.wallTimeMs);
  const firstByStage = new Map<string, StreamingTraceMarker>();
  for (const marker of markers) {
    if (!firstByStage.has(marker.stage)) firstByStage.set(marker.stage, marker);
  }
  const order = [
    "provider-delta-received",
    "delta-accepted-by-channel",
    "stream-flush-started",
    "sqlite-append-started",
    "sqlite-append-completed",
    "projection-event-created",
    "runtime-event-serialized",
    "runtime-websocket-send-accepted",
    "renderer-websocket-message-received",
    "renderer-projection-updated",
    "renderer-live-text-commit",
    "stream-paint",
    "provider-completion-received",
    "terminal-persistence-completed",
    "terminal-event-projected",
    "final-markdown-commit",
    "final-answer-paint",
  ];
  const first = firstByStage.get(order[0]!);
  const stages = order.map((stage, index) => {
    const marker = firstByStage.get(stage);
    const previous = index > 0 ? firstByStage.get(order[index - 1]!) : undefined;
    return {
      stage,
      wallTimeMs: marker?.wallTimeMs ?? null,
      durationSincePreviousMs: marker && previous
        ? Number((marker.wallTimeMs - previous.wallTimeMs).toFixed(3))
        : null,
      cumulativeFromProviderMs: marker && first
        ? Number((marker.wallTimeMs - first.wallTimeMs).toFixed(3))
        : null,
    };
  });
  const paint = firstByStage.get("stream-paint");
  const completion = firstByStage.get("provider-completion-received");
  const finalPaint = firstByStage.get("final-answer-paint");
  return {
    clock: "Cross-process durations use bounded Date.now wall-clock markers; per-process monotonic timestamps remain in the raw trace.",
    stages,
    firstDeltaToFirstPaintMs: first && paint
      ? Number((paint.wallTimeMs - first.wallTimeMs).toFixed(3))
      : null,
    completionToFinalPaintMs: completion && finalPaint
      ? Number((finalPaint.wallTimeMs - completion.wallTimeMs).toFixed(3))
      : null,
    rawRuntimeMarkers: runtime,
    rawRendererMarkers: renderer,
  };
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

interface BenchmarkConversationIds {
  primaryId: string;
  secondaryId: string;
}

function seedRuntime(dataDirectory: string, workspace: string): BenchmarkConversationIds {
  const store = new RuntimeStore(
    join(dataDirectory, "inertia.sqlite"),
    workspace,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Performance fixture", workspace);
  const primary = store.createConversation(project.id, "Performance primary");
  const baseTime = Date.now() - 300 * 60_000;
  for (let index = 0; index < 300; index += 1) {
    const requestedAt = new Date(baseTime + index * 60_000).toISOString();
    const startedAt = new Date(baseTime + index * 60_000 + 250).toISOString();
    const completedAt = new Date(baseTime + index * 60_000 + 2_000).toISOString();
    const { turn } = store.beginAgentTurn({
      id: `performance-authoritative-turn-${String(index).padStart(3, "0")}`,
      conversationId: primary.id,
      runId: `performance-authoritative-run-${index}`,
      content: `Authoritative request ${index}: inspect the durable transcript path and summarize the result.`,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: "provider-default",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
      requestedAt,
    });
    store.updateAgentTurnLifecycle(turn.id, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });
    if (index % 25 === 0) {
      const reasoning = store.createReasoning(primary.id, turn.runId, turn.id);
      store.appendReasoningContent(reasoning.id, `Reasoning summary ${index}: preserve the ordered lifecycle and inspect the measured viewport.`);
      store.updateReasoning(reasoning.id, { status: "completed" });
      store.upsertAgentPlan({
        conversationId: primary.id,
        runId: turn.runId,
        turnId: turn.id,
        explanation: `Plan for authoritative turn ${index}`,
        steps: [
          { step: "Persist the request", status: "completed" },
          { step: "Render the bounded timeline row", status: "completed" },
        ],
      });
    }
    if (index % 10 === 0) {
      store.addActivity({
        conversationId: primary.id,
        runId: turn.runId,
        turnId: turn.id,
        kind: index % 20 === 0 ? "command" : "tool",
        title: `Measured activity ${index}`,
        detail: "Representative settled activity detail for long-session virtualization.",
        status: "completed",
        createdAt: completedAt,
      });
    }
    const answer = store.createMessage(
      primary.id,
      [
        `## Authoritative answer ${index}`,
        "",
        "This answer is attached to a real authoritative turn and includes representative Markdown.",
        "",
        `- Durable request ${index} remains ordered.`,
        "- Settled heavy details stay behind their disclosure.",
        "",
        "```ts",
        `const measuredTurn = ${index};\nconst viewport = ".message-scroll";`,
        "```",
      ].join("\n"),
      "assistant",
      [],
      turn.id,
      completedAt,
    );
    store.settleAgentTurn(turn.id, {
      status: "completed",
      startedAt,
      completedAt,
      updatedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      terminalReason: "provider-completed",
    });
    if (index % 20 === 0) {
      store.createTurnGitArtifact({
        id: `performance-authoritative-artifact-${index}`,
        turnId: turn.id,
        branch: "main",
        createdAt: completedAt,
      });
      store.completeTurnGitArtifact(turn.id, {
        files: [{
          path: `src/performance-fixture-${index}.ts`,
          previousPath: null,
          status: "M",
          insertions: 4,
          deletions: 1,
          untracked: false,
          staged: false,
          unstaged: true,
          indexStatus: " ",
          worktreeStatus: "M",
          binary: false,
        }],
        insertions: 4,
        deletions: 1,
        status: "ready",
        completeness: "complete",
        patchState: "none",
        capturedAt: completedAt,
        terminalAssistantMessageId: answer.id,
        updatedAt: completedAt,
      });
    }
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
  return { primaryId: primary.id, secondaryId: secondary.id };
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
      INERTIA_STREAMING_TRACE: "1",
      INERTIA_DATA_DIR: dataDirectory,
      INERTIA_WORKSPACE_DIR: workspace,
      INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED: process.execPath,
    },
  });
  const page = await electronApp.firstWindow();
  const firstWindowMs = performance.now() - startedAt;
  await page.locator('.app-shell[data-connection-status="online"]').waitFor();
  await page.getByRole("textbox", { name: "Message" }).first().waitFor();
  await page.evaluate(() => {
    Reflect.set(globalThis, "__inertiaTestStreamingTrace", (stage: string) => {
      performance.mark(`inertia-stream:${stage}`, {
        detail: { wallTimeMs: Date.now() },
      });
    });
  });
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

async function authoritativeScrollSample(page: Page, expectedRows = 300) {
  await expect(page.locator(".orphan-run-flow")).toHaveCount(0);
  const viewportLocator = page.locator(".message-scroll");
  await viewportLocator.hover();
  await page.mouse.wheel(0, -1);
  const result = await viewportLocator.evaluate(async (viewport, expectedRows) => {
    const frameIntervals: number[] = [];
    const topPositions: number[] = [];
    const bottomGaps: number[] = [];
    let maximumDescendants = 0;
    const timeline = viewport.querySelector<HTMLElement>(".response-timeline");
    if (!timeline || viewport.scrollHeight <= viewport.clientHeight) {
      throw new Error("The authoritative transcript viewport is not scrollable.");
    }
    const feed = timeline.querySelector<HTMLElement>('[role="feed"]');
    if (!feed) throw new Error("Authoritative transcript virtualization is disabled.");
    const firstRow = feed.querySelector<HTMLElement>(".response-virtual-item");
    const totalRows = Number(firstRow?.getAttribute("aria-setsize") ?? 0);
    if (totalRows !== expectedRows) {
      throw new Error(`Expected ${expectedRows} authoritative rows, got ${totalRows}.`);
    }
    const waitForFrame = (): Promise<number> => new Promise((resolveFrame) => {
      requestAnimationFrame((now) => resolveFrame(now));
    });
    const scrollTo = (target: number): void => {
      viewport.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        deltaY: target === 0 ? -1 : 1,
      }));
      viewport.scrollTop = target;
    };
    scrollTo(0);
    await waitForFrame();
    let previous = performance.now();
    for (let index = 0; index < 120; index += 1) {
      const before = viewport.scrollTop;
      const target = index % 2 === 0 ? viewport.scrollHeight : 0;
      scrollTo(target);
      const now = await waitForFrame();
      frameIntervals.push(now - previous);
      previous = now;
      const top = viewport.scrollTop;
      const bottomGap = viewport.scrollHeight - viewport.clientHeight - top;
      if (target > 0 && Math.abs(top - before) < 1) {
        throw new Error("A benchmark scroll assignment was a no-op.");
      }
      if (index % 2 === 0 && bottomGap > 2) {
        throw new Error(`The viewport did not reach the bottom: gap ${bottomGap}.`);
      }
      if (index % 2 === 1 && top > 2) {
        throw new Error(`The viewport did not reach the top: ${top}.`);
      }
      topPositions.push(top);
      bottomGaps.push(bottomGap);
      maximumDescendants = Math.max(maximumDescendants, viewport.querySelectorAll("*").length);
    }
    const ordered = [...frameIntervals].sort((left, right) => left - right);
    return {
      frames: frameIntervals.length,
      medianFrameMs: ordered[Math.floor(ordered.length / 2)] ?? 0,
      p95FrameMs: ordered[Math.floor(ordered.length * 0.95)] ?? 0,
      over25Ms: frameIntervals.filter((value) => value > 25).length,
      mountedAuthoritativeRows: feed.querySelectorAll(".response-virtual-item").length,
      totalTimelineRows: totalRows,
      maximumDomDescendants: maximumDescendants,
      scrollHeight: viewport.scrollHeight,
      actualTopPosition: Math.min(...topPositions),
      actualBottomGap: Math.max(
        ...bottomGaps.filter((_, index) => index % 2 === 0),
      ),
    };
  }, expectedRows);
  return result;
}

async function compatibilityHistorySample(page: Page) {
  const recoveredHistory = page.locator(".orphan-run-flow details");
  await expect(recoveredHistory).toHaveCount(1);
  await expect(recoveredHistory.locator(".message")).toHaveCount(0);
  await recoveredHistory.locator("summary").click();
  await expect(recoveredHistory).toHaveJSProperty("open", true);
  const expandedCount = await recoveredHistory.locator(".message").count();
  expect(expandedCount).toBeGreaterThan(0);
  await recoveredHistory.locator("summary").click();
  await expect(recoveredHistory).toHaveJSProperty("open", false);
  await expect(recoveredHistory.locator(".message")).toHaveCount(0);
  return {
    scenario: "recovered-compatibility-history",
    collapsedDescendants: 0,
    expandedMessages: expandedCount,
    releasedOnClose: true,
  };
}

async function streamingResponsivenessSample(
  electronApp: ElectronApplication,
  page: Page,
  dataDirectory: string,
) {
  // Long-history traversal is measured independently. Start this scenario at
  // the live edge so its provider-delta metric is not contaminated by restored
  // scroll state or another interaction performed by the benchmark.
  await page.locator(".message-scroll").evaluate(async (viewport) => {
    viewport.scrollTop = viewport.scrollHeight;
    await new Promise<void>((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
    });
  });
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
        rendererTraceMarks: StreamingTraceMarker[];
      }>((resolveMeasurement, rejectMeasurement) => {
      for (const entry of performance.getEntriesByType("mark")) {
        if (entry.name.startsWith("inertia-stream:")) {
          performance.clearMarks(entry.name);
        }
      }
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
        rejectMeasurement(new Error(JSON.stringify({
          message: "The deterministic stream did not settle.",
          visibleUpdates: visibleUpdates.length,
          firstProviderDeltaToPaintMs,
          completionToFinalPaintMs,
          liveRendererCount: document.querySelectorAll('[data-stream-renderer="plain-text"]').length,
          persistedAnswerCount: document.querySelectorAll('[data-answer-phase="persisted"] .response-markdown').length,
          finalAnswerText: Array.from(document.querySelectorAll<HTMLElement>('[data-answer-phase="persisted"] .response-markdown'))
            .find((element) => element.textContent?.includes("STREAM_PROVIDER_COMPLETE_"))
            ?.textContent?.slice(-120) ?? null,
        })));
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
          rendererTraceMarks: performance.getEntriesByType("mark")
            .filter((entry) => entry.name.startsWith("inertia-stream:"))
            .map((entry) => {
              const detail = (entry as PerformanceMark).detail;
              const wallTimeMs = detail
                && typeof detail === "object"
                && "wallTimeMs" in detail
                && typeof detail.wallTimeMs === "number"
                ? detail.wallTimeMs
                : performance.timeOrigin + entry.startTime;
              return {
                stage: entry.name.slice("inertia-stream:".length),
                wallTimeMs,
                monotonicMs: entry.startTime,
              };
            }),
        });
      };
      const samplePaint = (): void => {
        paintPending = false;
        const live = document.querySelector<HTMLElement>(
          '[data-stream-renderer="plain-text"]',
        );
        const finalAnswer = Array.from(document.querySelectorAll<HTMLElement>(
          '[data-answer-phase="persisted"] .response-markdown',
        )).find((element) => element.textContent?.includes("STREAM_PROVIDER_COMPLETE_")) ?? null;
        const visibleText = live?.textContent ?? finalAnswer?.textContent ?? "";
        if (live && visibleText && visibleText !== lastVisibleText) {
          lastVisibleText = visibleText;
          visibleUpdates.push(performance.now());
          const trace = Reflect.get(globalThis, "__inertiaTestStreamingTrace");
          if (typeof trace === "function") trace("stream-paint");
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
          const trace = Reflect.get(globalThis, "__inertiaTestStreamingTrace");
          if (typeof trace === "function") trace("final-answer-paint");
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
  const liveViewport = page.locator(".message-scroll");
  await liveViewport.hover();
  for (let gesture = 0; gesture < 8; gesture += 1) {
    await page.mouse.wheel(0, -30_000);
  }
  await expect.poll(() => liveViewport.evaluate(
    (viewport) => viewport.scrollTop,
  )).toBeLessThan(120);
  await page.waitForTimeout(150);
  const readerNavigationScrollTop = await liveViewport.evaluate(
    (viewport) => viewport.scrollTop,
  );
  const memoryDuring = await rendererMemorySample(
    electronApp,
    page,
    "stream-during",
  );
  const processDuring = await processSample(electronApp);
  let jumpToLatestBottomGap = Number.POSITIVE_INFINITY;
  try {
    const jumpToLatest = page.getByRole("button", { name: "Jump to latest" });
    await expect(jumpToLatest).toBeVisible();
    await jumpToLatest.click();
    await expect.poll(() => liveViewport.evaluate(
      (viewport) => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    )).toBeLessThanOrEqual(120);
    jumpToLatestBottomGap = await liveViewport.evaluate(
      (viewport) => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    );
    await page.locator('[data-answer-phase="persisted"] .response-markdown').last().waitFor();
  } catch (error) {
    console.error(
      "[benchmark follow-latest failed]",
      error,
      await liveViewport.evaluate((viewport) => ({
        scrollTop: viewport.scrollTop,
        bottomGap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      })).catch(() => null),
    );
    throw error;
  }
  const visible = await measurementPromise;
  const memoryAfter = await rendererMemorySample(
    electronApp,
    page,
    "stream-after",
  );
  const processAfter = await processSample(electronApp);
  const runtimeTrace = (await readFile(join(dataDirectory, "streaming-trace.jsonl"), "utf8")
    .catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const marker = JSON.parse(line) as StreamingTraceMarker;
        return typeof marker.stage === "string" && Number.isFinite(marker.wallTimeMs)
          ? [marker]
          : [];
      } catch {
        return [];
      }
    });
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
    stageAttribution: stageAttribution(runtimeTrace, visible.rendererTraceMarks),
    followLatest: {
      startedAtLiveEdge: true,
      readerNavigationPreserved: readerNavigationScrollTop < 120,
      jumpToLatestReachedBottom: true,
      jumpToLatestBottomGap,
      finalAnswerVisible: true,
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
  const fixtureConversationIds = seedRuntime(dataDirectory, workspace);

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
    const authoritativeLongConversation = await authoritativeScrollSample(cold.page);
    const streamingResponsiveness = await streamingResponsivenessSample(
      cold.electronApp,
      cold.page,
      dataDirectory,
    );
    // Deliberately mounting thousands of recovered nodes and then unmounting
    // them can schedule cleanup/GC work. Keep that workload after streaming so
    // neither scenario measures the other's teardown cost.

    const selectCompatibility = new RuntimeStore(
      join(dataDirectory, "inertia.sqlite"),
      workspace,
      { recoverInterruptedRuns: false },
    );
    selectCompatibility.selectConversation(fixtureConversationIds.secondaryId);
    selectCompatibility.close();
    await cold.page.reload();
    await cold.page.locator('.app-shell[data-connection-status="online"]').waitFor();
    await cold.page.getByRole("textbox", { name: "Message" }).first().waitFor();
    const compatibilityHistory = await compatibilityHistorySample(cold.page);
    const selectPrimary = new RuntimeStore(
      join(dataDirectory, "inertia.sqlite"),
      workspace,
      { recoverInterruptedRuns: false },
    );
    selectPrimary.selectConversation(fixtureConversationIds.primaryId);
    selectPrimary.close();
    await cold.page.reload();
    await cold.page.locator('.app-shell[data-connection-status="online"]').waitFor();
    await cold.page.getByRole("textbox", { name: "Message" }).first().waitFor();

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
      soakScrollSamples.push(await authoritativeScrollSample(cold.page, 301));
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
      schemaVersion: 3,
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
        primaryTurns: 300,
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
        authoritativeLongConversation,
        compatibilityHistory,
          streamingResponsiveness: {
            ...streamingResponsiveness,
            stableTargets: {
              firstProviderDeltaToPaintMs: 100,
              p95VisibleGapMs: 100,
              firstPaintMet:
                streamingResponsiveness.firstProviderDeltaToPaintMs < 100,
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
        "The authoritative long-conversation fixture creates 300 queued, running, and settled turns through RuntimeStore lifecycle APIs; the compatibility scenario separately stresses collapsed orphan history.",
        "Desktop streaming uses a deterministic local Codex app-server fixture; it exercises the production provider, utility-runtime, SQLite, WebSocket, React, and paint path without network variance.",
        "Cross-process streaming attribution uses bounded wall-clock markers only for comparison; stage ordering remains authoritative within each process.",
        "The product owns one BrowserWindow; split chat is measured instead of inventing a multi-window mode.",
        "GPU information is observational; the benchmark does not force an adapter or Chromium feature flag.",
      ],
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    expect(report.scenarios.authoritativeLongConversation.frames).toBe(120);
    expect(report.scenarios.authoritativeLongConversation.totalTimelineRows).toBe(300);
    expect(report.scenarios.authoritativeLongConversation.actualTopPosition).toBeLessThanOrEqual(2);
    expect(report.scenarios.authoritativeLongConversation.actualBottomGap).toBeLessThanOrEqual(2);
    expect(report.scenarios.authoritativeLongConversation.mountedAuthoritativeRows).toBeLessThan(40);
    expect(report.scenarios.compatibilityHistory.releasedOnClose).toBe(true);
    expect(report.scenarios.streamingResponsiveness.firstProviderDeltaToPaintMs)
      .toBeLessThan(CI_STREAM_FIRST_PAINT_CATASTROPHIC_MS);
    expect(report.scenarios.streamingResponsiveness.p95VisibleGapMs)
      .toBeLessThan(CI_STREAM_VISIBLE_GAP_CATASTROPHIC_MS);
    expect(report.scenarios.streamingResponsiveness.visibleUpdates)
      .toBeGreaterThan(4);
    expect(report.scenarios.streamingResponsiveness.walBytes)
      .toBeGreaterThan(0);
    expect(report.scenarios.streamingResponsiveness.completionToFinalPaintMs)
      .toBeLessThan(CI_STREAM_FINAL_PAINT_CATASTROPHIC_MS);
    expect(report.scenarios.streamingResponsiveness.longTaskTotalMs)
      .toBeLessThan(CI_STREAM_LONG_TASK_CATASTROPHIC_MS);
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
