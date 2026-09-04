import { expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import type { ServerEvent } from "../../src/shared/contracts";
import { createAppFixture } from "./support/app-fixture";

declare global {
  interface Window {
    __backgroundCounters: { reactCommits: number; rafCallbacks: number; rendererInjected: boolean; lastActivityAt: number };
  }
}

function seedHistory(testDirectory: string, workspaceDirectory: string, turns: number): void {
  const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  try {
    const projectId = store.shellSnapshot().activeProjectId!;
    const conversation = store.createConversation(projectId, "Background history fixture");
    store.updateConversation(conversation.id, {
      reasoningEffort: "ultra",
      modelSelection: { ...conversation.modelSelection, reasoningEffort: "ultra" },
    });
    for (let index = 0; index < turns; index++) {
      const requestedAt = new Date(Date.now() - 200_000 + index * 1_000).toISOString();
      const { turn } = store.beginAgentTurn({
        id: `background-turn-${index}`, runId: `background-run-${index}`,
        conversationId: conversation.id, content: `History request ${index}`,
        providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
        model: "gpt-5.6", reasoningEffort: "ultra", interactionMode: "build", accessMode: "supervised",
        configurationRevision: 1, association: "authoritative", requestedAt,
      });
      for (let activity = 0; activity < 74; activity++) store.addActivity({
        conversationId: conversation.id, turnId: turn.id, runId: turn.runId,
        kind: "command", title: `Command ${index}.${activity}`,
        detail: "Synthetic bounded-history fixture. ".repeat(20), status: "completed",
      });
      for (let message = 0; message < 6; message++) store.createMessage(
        conversation.id, `Commentary ${index}.${message}`, "assistant", [], turn.id, requestedAt,
      );
      const answer = store.createMessage(conversation.id, `Final answer ${index}`, "assistant", [], turn.id, requestedAt);
      store.updateAgentTurnLifecycle(turn.id, {
        status: "completed", startedAt: requestedAt, completedAt: requestedAt, updatedAt: requestedAt,
        terminalAssistantMessageId: answer.id, terminalReason: "provider-completed",
      });
    }
  } finally { store.close(); }
}

async function processMetrics(page: Page, electronApp: ElectronApplication) {
  const window = await electronApp.browserWindow(page);
  const rendererPid = await window.evaluate((browserWindow) => browserWindow.webContents.getOSProcessId());
  const metrics = await electronApp.evaluate(({ app }, pid) =>
    app.getAppMetrics().filter((metric) => metric.pid === pid || metric.type === "GPU")
      .map((metric) => ({
        role: metric.pid === pid ? "renderer" : "gpu", pid: metric.pid,
        cpuPercent: metric.cpu.percentCPUUsage, cpuSeconds: metric.cpu.cumulativeCPUUsage ?? null,
        workingSetKb: metric.memory.workingSetSize, privateKb: metric.memory.privateBytes ?? null,
      })), rendererPid);
  return Promise.all(metrics.map(async (metric) => {
    let rssKb: number | null = null, pssKb: number | null = null;
    if (process.platform === "linux") {
      const memory = await readFile(`/proc/${metric.pid}/smaps_rollup`, "utf8");
      rssKb = Number(/^Rss:\s+(\d+)/mu.exec(memory)?.[1] ?? 0);
      pssKb = Number(/^Pss:\s+(\d+)/mu.exec(memory)?.[1] ?? 0);
    }
    return { ...metric, rssKb, pssKb };
  }));
}

async function sample(page: Page, electronApp: ElectronApplication, name: string, testInfo: TestInfo) {
  // Initial runtime replies can arrive after the shell becomes visible. Start
  // the idle measurement only after those commits and focus effects settle;
  // retain the full five-second zero-work assertion after this bounded wait.
  const settlingStartedAt = await page.evaluate(() => performance.now());
  await expect.poll(() => page.evaluate((startedAt) =>
    performance.now() - Math.max(startedAt, window.__backgroundCounters.lastActivityAt),
  settlingStartedAt), { timeout: 15_000 }).toBeGreaterThan(2_000);
  const session = await page.context().newCDPSession(page);
  const trace: { name: string; dur?: number; ph: string }[] = [];
  session.on("Tracing.dataCollected", ({ value }) => {
    const events = value as unknown as typeof trace;
    if (trace.length < 50_000) trace.push(...events.slice(0, 50_000 - trace.length));
  });
  await session.send("Tracing.start", {
    categories: "devtools.timeline,v8,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  const processesBefore = await processMetrics(page, electronApp);
  const sampledAt = performance.now();
  const start = await page.evaluate(() => ({
    focus: document.hasFocus(), visibility: document.visibilityState, counters: { ...window.__backgroundCounters },
    animations: document.getAnimations().map((animation) => ({
      state: animation.playState, time: animation.currentTime,
      name: animation instanceof CSSAnimation ? animation.animationName : "web-animation",
    })),
  }));
  await page.waitForTimeout(5_000);
  const processes = await processMetrics(page, electronApp);
  const elapsedMs = performance.now() - sampledAt;
  const heap = await session.send("Runtime.getHeapUsage");
  const end = await page.evaluate(() => ({
    focus: document.hasFocus(), visibility: document.visibilityState, counters: { ...window.__backgroundCounters },
    animations: document.getAnimations().map((animation) => ({
      state: animation.playState, time: animation.currentTime,
      name: animation instanceof CSSAnimation ? animation.animationName : "web-animation",
    })),
    mountedRows: document.querySelectorAll(".response-virtual-item, .response-static-item").length,
    domNodes: document.querySelectorAll("*").length,
  }));
  const completed = new Promise<void>((resolve) => session.once("Tracing.tracingComplete", () => resolve()));
  await session.send("Tracing.end");
  await completed;
  await session.detach();
  const traceDirectory = join("performance-results", "renderer-background", testInfo.testId.replace(/[^a-zA-Z0-9_-]/gu, "_"));
  await mkdir(traceDirectory, { recursive: true });
  const tracePath = join(traceDirectory, `${name}-renderer-trace.json`);
  await writeFile(tracePath, JSON.stringify({ traceEvents: trace }));
  await testInfo.attach(`${name}-renderer-trace`, { path: tracePath, contentType: "application/json" });
  const eventTotals: Record<string, { count: number; durationMs: number }> = {};
  for (const event of trace) {
    if (!/^(FireAnimationFrame|FunctionCall|TimerFire|Layout|UpdateLayoutTree|Paint|PrePaint|RasterTask|CompositeLayers|Commit|Layerize|DrawFrame|MinorGC|MajorGC)$/u.test(event.name)) continue;
    const total = eventTotals[event.name] ??= { count: 0, durationMs: 0 };
    total.count++;
    total.durationMs += (event.dur ?? 0) / 1_000;
  }
  return { name, startedAtMs: sampledAt, durationMs: elapsedMs, start, end, processes: processes.map((metric) => {
    const before = processesBefore.find((candidate) => candidate.pid === metric.pid);
    return { ...metric, oneCoreCpuPercent: metric.cpuSeconds !== null && before?.cpuSeconds != null
      ? (metric.cpuSeconds - before.cpuSeconds) / (elapsedMs / 1_000) * 100 : null };
  }), heap, eventTotals, traceEvents: trace.length };
}

for (const turns of [2, 128]) {
test(`bounds background motion for ${turns} turns and resumes on focus`, async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await createAppFixture({
    name: `renderer-background-${turns}`, initialState: "conversation", windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => seedHistory(testDirectory, workspaceDirectory, turns),
  });
  const { page, electronApp } = fixture;
  const mainWindow = await electronApp.browserWindow(page);
  const mainWindowId = await mainWindow.evaluate((window) => window.id);
  const runtimeEvents: { type: string; receivedAtMs: number }[] = [];
  let initialBackupReady = false;
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const message = JSON.parse(String(payload)) as ServerEvent;
    const event = message.type === "runtime.event" ? message.event : message;
    if ((event.type === "server.welcome" || event.type === "snapshot.updated")
      && event.snapshot.databaseBackup?.lastValidatedAt) initialBackupReady = true;
    if (runtimeEvents.length < 100) runtimeEvents.push({
      type: event.type, receivedAtMs: performance.now(),
    });
  }));
  try {
    await page.addInitScript(() => {
      const counters = { reactCommits: 0, rafCallbacks: 0, rendererInjected: false, lastActivityAt: performance.now() };
      window.__backgroundCounters = counters;
      Object.assign(window, { __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        inject() { counters.rendererInjected = true; return 1; },
        onCommitFiberRoot() { counters.reactCommits++; counters.lastActivityAt = performance.now(); },
        onCommitFiberUnmount() {},
      } });
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => requestFrame((time) => {
        counters.rafCallbacks++;
        counters.lastActivityAt = performance.now();
        callback(time);
      });
    });
    await page.reload();
    const focusSession = await page.context().newCDPSession(page);
    await focusSession.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await expect(page.getByRole("heading", { name: "Background history fixture", level: 1 })).toBeVisible();
    if (turns === 128) {
      await expect(page.getByRole("feed", { name: `${turns} conversation turns` })).toBeVisible();
      await expect.poll(() => page.locator(".response-virtual-item").count()).toBeLessThan(24);
    } else {
      await expect(page.locator(".response-static-item")).toHaveCount(turns);
    }
    // The scheduled initial backup publishes a real snapshot after its quiet
    // grace. Measure idle motion after that one-time startup work completes.
    await expect.poll(() => initialBackupReady, { timeout: 60_000 }).toBe(true);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await mainWindow.evaluate((window) => { window.focus(); window.webContents.focus(); });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const foreground = await sample(page, electronApp, "foreground", testInfo);
    const backgroundRequestedAt = performance.now();
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const other = new BrowserWindow({ width: 180, height: 120, x: 0, y: 0, show: true });
      await other.loadURL("data:text/html,<title>Focus fixture</title>");
      for (const window of BrowserWindow.getAllWindows()) if (window !== other) window.blur();
      other.focus();
      other.webContents.focus();
    });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    await expect.poll(() => page.evaluate(() => {
      const animations = document.getAnimations();
      return animations.length > 0 && animations.every((animation) => animation.playState === "paused");
    })).toBe(true);
    const pauseObservedMs = performance.now() - backgroundRequestedAt;
    const background = await sample(page, electronApp, "mapped-unfocused", testInfo);
    await mainWindow.evaluate((window) => window.minimize());
    try {
      // Native minimization completes asynchronously, including its macOS
      // animation. Hiding during that transition can cancel the request.
      await expect.poll(() => mainWindow.evaluate((window) => window.isMinimized()), {
        timeout: 5_000,
      }).toBe(true);
    } catch (error) {
      if (process.platform !== "linux") throw error;
      // Bare Xvfb has no window manager to honor minimization. Native hiding
      // still exercises an unmapped window there without faking DOM state.
      await mainWindow.evaluate((window) => window.hide());
      await expect.poll(() => mainWindow.evaluate((window) => window.isVisible())).toBe(false);
    }
    const nativeWindowState = await mainWindow.evaluate((window) => ({
      minimized: window.isMinimized(), visible: window.isVisible(),
    }));
    expect(nativeWindowState.minimized || !nativeWindowState.visible).toBe(true);
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    // Playwright disables Chromium occlusion/background throttling, so record
    // the actual visibility state instead of assuming minimization hides it.
    const minimized = { ...await sample(page, electronApp, "minimized-or-hidden", testInfo), nativeWindowState };
    await mainWindow.evaluate((window) => { window.restore(); window.show(); });
    await electronApp.evaluate(({ BrowserWindow }, id) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.id !== id) window.destroy();
        else { window.focus(); window.webContents.focus(); }
      }
    }, mainWindowId);
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const resumed = await sample(page, electronApp, "resumed", testInfo);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => page.evaluate(() => document.getAnimations().some(
      (animation) => animation instanceof CSSAnimation && animation.animationName === "ultra-reasoning-frame-flow",
    ))).toBe(false);
    const report = JSON.stringify({ turns, activities: turns * 74, messages: turns * 8, pauseObservedMs, runtimeEvents, foreground, background, resumed, minimized }, null, 2);
    await mkdir("performance-results", { recursive: true });
    await writeFile(`performance-results/renderer-background-${process.platform}-${process.arch}-${turns}.json`, report);
    await testInfo.attach("renderer-background-profile", {
      body: Buffer.from(report),
      contentType: "application/json",
    });
    expect(background.start.counters.rendererInjected).toBe(true);
    for (const measurement of [background, minimized]) {
      expect(measurement.start.focus).toBe(false);
      expect(measurement.end.focus).toBe(false);
      expect(measurement.end.animations).toEqual(measurement.start.animations);
      expect(measurement.end.animations.every((animation) => animation.state === "paused")).toBe(true);
      expect(measurement.end.counters.reactCommits).toBe(measurement.start.counters.reactCommits);
      expect(measurement.end.counters.rafCallbacks).toBe(measurement.start.counters.rafCallbacks);
      expect(measurement.end.mountedRows).toBeLessThan(24);
    }
    for (const measurement of [foreground, resumed]) {
      const start = measurement.start.animations.find((animation) => animation.name === "ultra-reasoning-frame-flow");
      const end = measurement.end.animations.find((animation) => animation.name === "ultra-reasoning-frame-flow");
      expect(start?.state).toBe("running");
      expect(end?.state).toBe("running");
      expect(Number(end?.time) - Number(start?.time)).toBeGreaterThan(4_000);
    }
    expect(fixture.rendererErrors).toEqual([]);
  } finally { await fixture.close(); }
});
}
