import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  expect,
  test,
  _electron as electron,
  type CDPSession,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { quitElectronAppBounded } from "../e2e/support/electron-app-lifecycle";
import {
  BENCHMARK_LOGIN_MARKER,
  benchmarkLoginFixtureSource,
} from "../helpers/desktop-benchmark-readiness-diagnostic";
import {
  cleanupStreamingCompletionGate,
  releaseStreamingCadence,
  releaseStreamingCompletion,
  STREAMING_PROGRESSIVE_PAINT_COUNT,
  streamingAppServer,
  streamingCompletionGatePaths,
} from "../helpers/desktop-benchmark-streaming-fixture";
import { ablationSource, installFrameRecorder, reactCommitCounterSource, type FrameRecording } from "./scroll-profile-page";
import { seedScrollProfile } from "./scroll-profile-seed";

const execFileAsync = promisify(execFile);
const scenario = process.env.INERTIA_SCROLL_SCENARIO ?? "transcript";
const rows = Number(process.env.INERTIA_SCROLL_ROWS ?? (scenario === "sidebar" ? 40 : 300));
const sidebarConversations = Number(process.env.INERTIA_SCROLL_SIDEBAR_CHATS ?? (scenario === "sidebar" ? 500 : 0));
const traceEnabled = process.env.INERTIA_SCROLL_TRACE === "1";
const commitCounting = process.env.INERTIA_SCROLL_COMMITS === "1";
const coverageSampling = process.env.INERTIA_SCROLL_COVERAGE === "1";
const ablations = (process.env.INERTIA_SCROLL_ABLATE ?? "").split(",").filter(Boolean);
const appRoot = resolve(process.env.INERTIA_SCROLL_APP_ROOT ?? ".");
const runLabel = process.env.INERTIA_SCROLL_LABEL ?? `${scenario}-${rows}`;
const outputDirectory = resolve(process.env.INERTIA_SCROLL_OUTPUT ?? join("performance-results", "scroll-profile", runLabel));
const wheelSpeed = Number(process.env.INERTIA_SCROLL_WHEEL_SPEED ?? 5_000);
const wheelDistanceLimit = Number(process.env.INERTIA_SCROLL_WHEEL_DISTANCE ?? 60_000);
const cssOverride = process.env.INERTIA_SCROLL_CSS_OVERRIDE ?? "";
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "blink",
  "v8",
  "toplevel",
  "latencyInfo",
];

interface PassResult {
  pass: string;
  frames: Omit<FrameRecording, "intervals" | "longAnimationFrames"> & { longAnimationFrameCount: number };
  extra: Record<string, unknown>;
  commits: unknown;
}

test.setTimeout(30 * 60_000);

async function initializeWorkspace(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src"), { recursive: true });
  await Promise.all(Array.from({ length: 120 }, async (_, index) => {
    await writeFile(join(workspace, "src", `module-${String(index).padStart(3, "0")}.ts`), `export const value = ${index};\n`);
  }));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["-c", "user.name=Inertia Scroll Profile", "-c", "user.email=scroll@inertia.local", "commit", "-qm", "fixture"], { cwd: workspace });
  await Promise.all([
    writeFile(join(workspace, "app-server"), streamingAppServer, "utf8"),
    writeFile(join(workspace, "login"), benchmarkLoginFixtureSource, "utf8"),
    writeFile(join(workspace, ".git", "info", "exclude"), `app-server\nlogin\nprojects/\n.inertia-stream-completion-*\n${BENCHMARK_LOGIN_MARKER}\n`, { encoding: "utf8", flag: "a" }),
  ]);
}

async function readStream(session: CDPSession, handle: string, path: string): Promise<void> {
  const output = createWriteStream(path);
  try {
    for (;;) {
      const chunk = await session.send("IO.read", { handle, size: 4 * 1024 * 1024 });
      output.write(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
      if (chunk.eof) break;
    }
  } finally {
    await new Promise<void>((resolveEnd) => output.end(() => resolveEnd()));
    await session.send("IO.close", { handle });
  }
}

async function measurePass(
  page: Page,
  session: CDPSession,
  name: string,
  selectors: { scroll: string; row: string },
  action: () => Promise<Record<string, unknown>>,
): Promise<PassResult> {
  await page.evaluate(installFrameRecorder);
  await page.evaluate(() => new Promise<void>((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
  }));
  if (traceEnabled) {
    await session.send("Tracing.start", {
      transferMode: "ReturnAsStream",
      traceConfig: { includedCategories: TRACE_CATEGORIES, recordMode: "recordAsMuchAsPossible" },
    });
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: 200 });
    await session.send("Profiler.start");
  }
  if (commitCounting) await page.evaluate(() => (Reflect.get(window, "__scrollProfileCommits") as { start(): void }).start());
  await page.evaluate(({ scroll, row, coverage }) => {
    (Reflect.get(window, "__scrollProfileFrames") as { start(a: string, b: string, c: boolean): void }).start(scroll, row, coverage);
  }, { ...selectors, coverage: coverageSampling });
  const startedAt = performance.now();
  const extra = await action();
  const actionMs = performance.now() - startedAt;
  const recording = await page.evaluate(() => (Reflect.get(window, "__scrollProfileFrames") as { stop(): unknown }).stop()) as FrameRecording;
  const commits = commitCounting
    ? await page.evaluate(() => (Reflect.get(window, "__scrollProfileCommits") as { stop(): unknown }).stop())
    : null;
  if (traceEnabled) {
    const { profile } = await session.send("Profiler.stop");
    await session.send("Profiler.disable");
    await writeFile(join(outputDirectory, `${name}.cpuprofile`), JSON.stringify(profile));
    const complete = new Promise<{ stream?: string }>((resolveTrace) => session.once("Tracing.tracingComplete", resolveTrace));
    await session.send("Tracing.end");
    const { stream } = await complete;
    if (stream) await readStream(session, stream, join(outputDirectory, `${name}.trace.json`));
  }
  await writeFile(join(outputDirectory, `${name}.frames.json`), JSON.stringify({ ...recording, extra, actionMs }, null, 1));
  if (commits) await writeFile(join(outputDirectory, `${name}.commits.json`), JSON.stringify(commits, null, 1));
  const { intervals: _intervals, longAnimationFrames, ...frames } = recording;
  return {
    pass: name,
    frames: { ...frames, longAnimationFrameCount: longAnimationFrames.length },
    extra: { ...extra, actionMs: Number(actionMs.toFixed(1)) },
    commits: commits ? { commits: (commits as { commits: number }).commits } : null,
  };
}

async function viewportGeometry(page: Page, selector: string) {
  return await page.locator(selector).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollbarWidth: (element as HTMLElement).offsetWidth - element.clientWidth,
    };
  });
}

async function wheelGesture(page: Page, session: CDPSession, selector: string, direction: "up" | "down", distance: number) {
  const geometry = await viewportGeometry(page, selector);
  const before = geometry.scrollTop;
  const x = Math.round(geometry.left + geometry.width / 2);
  const y = Math.round(geometry.top + geometry.height / 2);
  let remaining = distance;
  while (remaining > 0) {
    const step = Math.min(remaining, 6_000);
    await session.send("Input.synthesizeScrollGesture", {
      x,
      y,
      yDistance: direction === "up" ? step : -step,
      speed: wheelSpeed,
      gestureSourceType: "mouse",
      preventFling: true,
    });
    remaining -= step;
    const now = await viewportGeometry(page, selector);
    if (direction === "up" && now.scrollTop <= 1) break;
    if (direction === "down" && now.scrollTop + now.clientHeight >= now.scrollHeight - 1) break;
  }
  const after = await viewportGeometry(page, selector);
  return { scrolledPx: Math.round(Math.abs(after.scrollTop - before)), scrollHeight: after.scrollHeight, requestedPx: distance };
}

async function thumbDrag(page: Page, selector: string, direction: "up" | "down", steps: number) {
  const geometry = await viewportGeometry(page, selector);
  const range = geometry.scrollHeight - geometry.clientHeight;
  const thumbHeight = Math.max(18, geometry.clientHeight * geometry.clientHeight / geometry.scrollHeight);
  const track = geometry.clientHeight - thumbHeight;
  const x = geometry.left + geometry.width - Math.max(2, geometry.scrollbarWidth / 2);
  const thumbCenter = geometry.top + (range > 0 ? geometry.scrollTop / range : 0) * track + thumbHeight / 2;
  const target = direction === "up" ? geometry.top + thumbHeight / 2 : geometry.top + track + thumbHeight / 2;
  const samples: number[] = [];
  await page.mouse.move(x, thumbCenter);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(x, thumbCenter + (target - thumbCenter) * step / steps);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 16));
    if (step % 10 === 0) samples.push(await page.locator(selector).evaluate((element) => Math.round(element.scrollTop)));
  }
  await page.mouse.up();
  const after = await viewportGeometry(page, selector);
  return {
    scrollbarWidth: geometry.scrollbarWidth,
    thumbHeight: Math.round(thumbHeight),
    startScrollTop: Math.round(geometry.scrollTop),
    endScrollTop: Math.round(after.scrollTop),
    scrollHeight: after.scrollHeight,
    scrollTopSamples: samples,
  };
}

async function loadedTurns(page: Page): Promise<number> {
  return await page.locator(".message-scroll").evaluate((element) => {
    const feed = element.querySelector('[role="feed"][aria-label$=" conversation turns"]');
    return feed
      ? Number(/^(\d+) conversation turns$/u.exec(feed.getAttribute("aria-label") ?? "")?.[1] ?? 0)
      : element.querySelectorAll(".response-static-item").length;
  });
}

async function loadAllHistory(page: Page, expected: number): Promise<number[]> {
  const transcript = page.locator(".message-scroll");
  const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  const pageLoads: number[] = [];
  await expect.poll(() => loadedTurns(page)).toBeGreaterThan(0);
  while (await loadedTurns(page) < expected) {
    const before = await loadedTurns(page);
    await transcript.evaluate((element) => { element.scrollTop = 0; });
    await earlier.waitFor({ state: "visible", timeout: 20_000 });
    const startedAt = performance.now();
    await earlier.click();
    await expect.poll(() => loadedTurns(page), { timeout: 30_000, intervals: [10, 20, 50] }).toBeGreaterThan(before);
    pageLoads.push(Number((performance.now() - startedAt).toFixed(1)));
  }
  await expect.poll(() => loadedTurns(page)).toBe(expected);
  return pageLoads;
}

async function jumpToLatest(page: Page): Promise<number> {
  const latest = page.getByRole("button", { name: "Jump to latest", exact: true });
  if (!await latest.isVisible()) return 0;
  const startedAt = performance.now();
  await latest.click();
  await expect.poll(() => page.locator(".message-scroll").evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight), { intervals: [5, 10, 20] }).toBeLessThan(120);
  return Number((performance.now() - startedAt).toFixed(1));
}

async function settle(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((duration) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, duration)), milliseconds);
}

async function waitForGateConsumed(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!await access(path).then(() => true, () => false)) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Streaming gate ${path} was not consumed.`);
}

async function startStream(page: Page, workspace: string, sampleNumber: number): Promise<void> {
  await cleanupStreamingCompletionGate(workspace, sampleNumber);
  const composer = page.getByRole("region", { name: "Message composer" });
  await composer.getByRole("textbox", { name: "Message" }).fill(`Run deterministic streaming responsiveness sample ${sampleNumber}.`);
  await composer.getByRole("button", { name: "Send message" }).click();
  await page.locator('[data-stream-renderer="plain-text"]').waitFor({ timeout: 20_000 });
  const { cadence } = streamingCompletionGatePaths(workspace, sampleNumber);
  for (let ordinal = 1; ordinal <= STREAMING_PROGRESSIVE_PAINT_COUNT; ordinal += 1) {
    await releaseStreamingCadence(workspace, sampleNumber);
    await waitForGateConsumed(cadence);
  }
}

async function finishStream(page: Page, workspace: string, sampleNumber: number): Promise<void> {
  const { ready } = streamingCompletionGatePaths(workspace, sampleNumber);
  const deadline = Date.now() + 60_000;
  while (!await access(ready).then(() => true, () => false)) {
    if (Date.now() > deadline) throw new Error("The stream never reached its completion gate.");
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  await releaseStreamingCompletion(workspace, sampleNumber);
  await expect(page.locator('[data-stream-renderer="plain-text"]')).toHaveCount(0, { timeout: 30_000 });
}

test("profiles scrolling", async () => {
  expect(process.version).toMatch(/^v22\./u);
  await mkdir(outputDirectory, { recursive: true });
  const fixtureRoot = await mkdtemp(join(tmpdir(), "inertia-scroll-profile-"));
  const dataDirectory = join(fixtureRoot, "data");
  const workspace = join(fixtureRoot, "workspace");
  const profile = join(fixtureRoot, "profile");
  const providerBin = join(fixtureRoot, "provider-bin");
  let electronApp: ElectronApplication | null = null;
  try {
    await Promise.all([dataDirectory, workspace, profile, providerBin].map((path) => mkdir(path, { recursive: true })));
    await initializeWorkspace(workspace);
    const seedStartedAt = performance.now();
    await seedScrollProfile(dataDirectory, workspace, {
      rows,
      sidebarConversations,
      sidebarProjects: sidebarConversations > 0 ? 10 : 1,
    });
    const seedMs = performance.now() - seedStartedAt;
    electronApp = await electron.launch({
      args: [appRoot, `--user-data-dir=${profile}`],
      cwd: appRoot,
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        INERTIA_DATA_DIR: dataDirectory,
        INERTIA_WORKSPACE_DIR: workspace,
        INERTIA_TEST_PROVIDER_BIN_DIR: providerBin,
        INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED: process.execPath,
        INERTIA_BENCHMARK_STREAM_INTERVAL_MS: process.env.INERTIA_BENCHMARK_STREAM_INTERVAL_MS ?? "80",
        INERTIA_BENCHMARK_COMPLETION_GATE_TIMEOUT_MS: "60000",
      },
    });
    let page = await electronApp.firstWindow();
    await page.locator('.app-shell[data-connection-status="online"]').waitFor({ timeout: 60_000 });
    if (commitCounting || ablations.length > 0) {
      if (commitCounting) await electronApp.context().addInitScript({ content: reactCommitCounterSource });
      if (ablations.length > 0) await electronApp.context().addInitScript({ content: ablationSource(ablations) });
      await page.reload();
      page = await electronApp.firstWindow();
      await page.locator('.app-shell[data-connection-status="online"]').waitFor({ timeout: 60_000 });
      if (commitCounting) expect(await page.evaluate(() => Boolean(Reflect.get(window, "__scrollProfileCommits")))).toBe(true);
    }
    await page.getByRole("textbox", { name: "Message" }).first().waitFor({ timeout: 60_000 });
    const nativeWindow = await electronApp.browserWindow(page);
    await nativeWindow.evaluate((browserWindow) => browserWindow.setContentSize(1440, 920));
    await nativeWindow.dispose();
    if (cssOverride) await page.addStyleTag({ content: cssOverride });
    await settle(page, 1_000);
    const session = await page.context().newCDPSession(page);
    const environment = await electronApp.evaluate(({ screen }) => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      scaleFactor: screen.getPrimaryDisplay().scaleFactor,
      displayFrequency: screen.getPrimaryDisplay().displayFrequency,
    }));
    const results: PassResult[] = [];
    const transcript = { scroll: ".message-scroll", row: ".response-virtual-item" };
    const sidebar = { scroll: ".project-list", row: ".work-index-virtual-item" };
    const meta: Record<string, unknown> = { seedMs: Number(seedMs.toFixed(0)) };
    const historyStartedAt = performance.now();
    meta.historyPageLoadsMs = await loadAllHistory(page, rows);
    meta.historyTotalMs = Number((performance.now() - historyStartedAt).toFixed(0));
    meta.initialJumpToLatestMs = await jumpToLatest(page);
    await settle(page, 1_500);
    meta.transcriptGeometry = await viewportGeometry(page, transcript.scroll);
    meta.mountedRows = await page.locator(transcript.row).count();
    meta.domNodes = await page.evaluate(() => document.querySelectorAll("*").length);
    if (scenario === "transcript") {
      const geometry = await viewportGeometry(page, transcript.scroll);
      const distance = Math.min(wheelDistanceLimit, geometry.scrollHeight - geometry.clientHeight);
      results.push(await measurePass(page, session, "wheel-up", transcript, () => wheelGesture(page, session, transcript.scroll, "up", distance)));
      await settle(page, 1_000);
      results.push(await measurePass(page, session, "wheel-down", transcript, () => wheelGesture(page, session, transcript.scroll, "down", distance)));
      await settle(page, 1_000);
      await jumpToLatest(page);
      await settle(page, 1_000);
      results.push(await measurePass(page, session, "thumb-drag-up", transcript, () => thumbDrag(page, transcript.scroll, "up", 180)));
      await settle(page, 1_000);
      results.push(await measurePass(page, session, "thumb-drag-down", transcript, () => thumbDrag(page, transcript.scroll, "down", 180)));
      await settle(page, 1_000);
      results.push(await measurePass(page, session, "idle-at-bottom", transcript, async () => {
        await settle(page, 2_000);
        return {};
      }));
    } else if (scenario === "streaming") {
      await startStream(page, workspace, 1);
      results.push(await measurePass(page, session, "stream-follow", transcript, async () => {
        await settle(page, 2_500);
        return {};
      }));
      results.push(await measurePass(page, session, "stream-wheel-up", transcript, () => wheelGesture(page, session, transcript.scroll, "up", 8_000)));
      results.push(await measurePass(page, session, "stream-reading-history", transcript, async () => {
        await settle(page, 1_500);
        return {};
      }));
      results.push(await measurePass(page, session, "stream-jump-latest", transcript, async () => {
        const jumpMs = await jumpToLatest(page);
        await settle(page, 1_200);
        return { jumpMs };
      }));
      await finishStream(page, workspace, 1);
    } else if (scenario === "sidebar") {
      const list = page.locator(sidebar.scroll);
      await list.evaluate((element) => { element.scrollTop = 0; });
      await settle(page, 500);
      meta.sidebarGeometry = await viewportGeometry(page, sidebar.scroll);
      meta.sidebarMountedRows = await page.locator(sidebar.row).count();
      const geometry = await viewportGeometry(page, sidebar.scroll);
      const distance = geometry.scrollHeight - geometry.clientHeight;
      results.push(await measurePass(page, session, "sidebar-wheel-down", sidebar, () => wheelGesture(page, session, sidebar.scroll, "down", distance)));
      await settle(page, 800);
      results.push(await measurePass(page, session, "sidebar-wheel-up", sidebar, () => wheelGesture(page, session, sidebar.scroll, "up", distance)));
      await settle(page, 800);
      await startStream(page, workspace, 1);
      results.push(await measurePass(page, session, "sidebar-wheel-down-while-streaming", sidebar, () => wheelGesture(page, session, sidebar.scroll, "down", distance)));
      results.push(await measurePass(page, session, "sidebar-idle-while-streaming", sidebar, async () => {
        await settle(page, 1_500);
        return {};
      }));
      await finishStream(page, workspace, 1);
      results.push(await measurePass(page, session, "sidebar-wheel-up-after-stream", sidebar, () => wheelGesture(page, session, sidebar.scroll, "up", distance)));
    }
    meta.ablationCounts = await page.evaluate(() => Reflect.get(window, "__scrollProfileAblations") ?? null);
    await session.detach().catch(() => undefined);
    await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify({
      scenario,
      rows,
      sidebarConversations,
      traceEnabled,
      commitCounting,
      coverageSampling,
      ablations,
      appRoot,
      cssOverride,
      host: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length },
      environment,
      meta,
      results,
    }, null, 2)}\n`);
  } finally {
    if (electronApp) {
      const current = electronApp;
      await quitElectronAppBounded(current, () => current.evaluate(() => {
        const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as { quit?: () => unknown } | undefined;
        return runtime?.quit?.() ?? null;
      })).catch(() => undefined);
    }
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
