import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { distribution } from "../helpers/desktop-benchmark-summary";
import {
  CONTENT_LOADING_CHAT_MESSAGES,
  initializeContentLoadingWorkspace,
  seedContentLoadingRuntime,
  type ContentLoadingChatSize,
  type ContentLoadingFixture,
} from "../helpers/content-loading-fixture";
import {
  CONTENT_LOADING_INIT_SCRIPT,
  type CommitRecord,
  type FrameRecord,
  type OlderPageSample,
  type OpenChatSample,
} from "./content-loading-instrumentation";

const LAUNCHES = Number(process.env.INERTIA_CONTENT_BENCHMARK_LAUNCHES ?? 5);
const WARM_CYCLES = Number(process.env.INERTIA_CONTENT_BENCHMARK_WARM_CYCLES ?? 2);
const OLDER_PAGES = Number(process.env.INERTIA_CONTENT_BENCHMARK_OLDER_PAGES ?? 24);
const INSTRUMENTED = process.env.INERTIA_CONTENT_BENCHMARK_INSTRUMENTED !== "0";
const reportPath = resolve(process.env.INERTIA_CONTENT_BENCHMARK_REPORT
  ?? `performance-results/content-loading-desktop-${process.platform}-${process.arch}.json`);
const profileDirectory = join(dirname(reportPath), "content-loading-profiles");
const OPEN_ORDER: ContentLoadingChatSize[] = [2_000, 300, 50];

interface LaunchResult {
  startupMs: number;
  loadBefore: number[];
  loadAfter: number[];
  initialFrames: { types: string[]; bytes: number }[];
  open: { size: ContentLoadingChatSize; cold: boolean; sample: OpenChatSample }[];
  older: OlderPageSample[];
  reopenAfterOlder: { turnsBeforeSwitch: number; turnsAfterReopen: number; reopenMs: number } | null;
}

async function launch(dataDirectory: string, workspace: string, profile: string, providerBin: string) {
  const startedAt = performance.now();
  const electronApp = await electron.launch({
    args: [".", `--user-data-dir=${profile}`],
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: dataDirectory,
      INERTIA_WORKSPACE_DIR: workspace,
      INERTIA_TEST_PROVIDER_BIN_DIR: providerBin,
    },
  });
  const page = await electronApp.firstWindow();
  await page.addInitScript(CONTENT_LOADING_INIT_SCRIPT);
  await page.locator('.app-shell[data-connection-status="online"]').waitFor({ timeout: 60_000 });
  await page.reload();
  await page.locator('.app-shell[data-connection-status="online"]').waitFor({ timeout: 60_000 });
  await page.getByRole("textbox", { name: "Message" }).first().waitFor({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, "__contentBench")))).toBe(true);
  return { electronApp, page, startupMs: performance.now() - startedAt };
}

async function closeApp(electronApp: ElectronApplication): Promise<void> {
  const child = electronApp.process();
  const closed = electronApp.close().then(() => true, () => false);
  const finished = await Promise.race([closed, new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 30_000))]);
  if (!finished && child.exitCode === null && child.pid) child.kill("SIGKILL");
}

async function settleIdle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bench = Reflect.get(window, "__contentBench") as { commits: { t: number }[] };
    const startedAt = performance.now();
    while (performance.now() - startedAt < 10_000) {
      await new Promise((resolveFrame) => setTimeout(resolveFrame, 100));
      const last = bench.commits.at(-1)?.t ?? 0;
      if (performance.now() - last > 600) return;
    }
  });
}

async function openChat(page: Page, title: string, marker: string): Promise<OpenChatSample> {
  return await page.evaluate(async ({ title, marker }) => {
    const bench = Reflect.get(window, "__contentBench") as {
      log: FrameRecord[]; longTasks: { start: number; duration: number }[]; commits: CommitRecord[]; census: boolean;
    };
    const nextFrame = () => new Promise<number>((resolveFrame) => requestAnimationFrame(resolveFrame));
    const button = [...document.querySelectorAll<HTMLElement>(".activity-thread-select")]
      .find((candidate) => candidate.textContent?.includes(title));
    if (!button) throw new Error(`Sidebar row ${title} is missing.`);
    const logStart = bench.log.length;
    const commitStart = bench.commits.length;
    const visibleMarker = () => {
      const scroller = document.querySelector<HTMLElement>(".message-scroll");
      if (!scroller) return false;
      const bounds = scroller.getBoundingClientRect();
      return [...scroller.querySelectorAll("h2")].some((heading) => {
        if (heading.textContent?.trim() !== marker) return false;
        const rect = heading.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.height > 0;
      });
    };
    const startedAt = performance.now();
    button.click();
    let visibleAt: number | null = null;
    while (performance.now() - startedAt < 30_000) {
      await nextFrame();
      if (visibleMarker()) { visibleAt = performance.now(); break; }
    }
    if (visibleAt === null) throw new Error(`The latest answer of ${title} never became visible.`);
    await new Promise((resolvePaint) => requestAnimationFrame(() => setTimeout(resolvePaint, 0)));
    const paintedAt = performance.now();
    const commitsToPaint = bench.commits.length - commitStart;
    let settledAt = paintedAt;
    while (performance.now() - paintedAt < 5_000) {
      await new Promise((resolveIdle) => setTimeout(resolveIdle, 50));
      const last = bench.commits.at(-1)?.t ?? 0;
      if (last > settledAt) settledAt = last;
      if (performance.now() - last > 500) break;
    }
    const frames = bench.log.slice(logStart).filter(({ t }) => t <= settledAt + 1).map(({ t, ...frame }) => ({ ...frame, atMs: t - startedAt }));
    const first = (predicate: (frame: (typeof frames)[number]) => boolean) => frames.find(predicate)?.atMs ?? null;
    const selectSent = first((frame) => frame.direction === "out" && frame.types.includes("conversation.select"));
    const snapshotReceived = first((frame) => frame.direction === "in" && frame.types.includes("snapshot.updated"));
    const detailSent = first((frame) => frame.direction === "out" && frame.types.includes("conversation.detail.load"));
    const detailReceived = first((frame) => frame.direction === "in" && frame.kind === "conversation.detail");
    const tasks = bench.longTasks.filter(({ start }) => start >= startedAt && start <= settledAt);
    const feed = document.querySelector('[role="feed"][aria-label$=" conversation turns"]');
    const loadedTurns = feed
      ? Number(/^(\d+) conversation turns$/u.exec(feed.getAttribute("aria-label") ?? "")?.[1] ?? 0)
      : document.querySelectorAll(".response-static-item").length;
    return {
      clickToVisibleMs: visibleAt - startedAt,
      clickToPaintMs: paintedAt - startedAt,
      clickToSettledMs: settledAt - startedAt,
      phases: {
        selectSentMs: selectSent,
        snapshotReceivedMs: snapshotReceived,
        detailRequestSentMs: detailSent,
        detailResultReceivedMs: detailReceived,
        detailRoundTripMs: detailSent !== null && detailReceived !== null ? detailReceived - detailSent : null,
        snapshotToDetailRequestMs: snapshotReceived !== null && detailSent !== null ? detailSent - snapshotReceived : null,
        resultToVisibleMs: detailReceived !== null ? visibleAt - startedAt - detailReceived : null,
      },
      frames,
      longTaskCount: tasks.length,
      longTaskTotalMs: tasks.reduce((total, { duration }) => total + duration, 0),
      longTaskMaxMs: tasks.reduce((maximum, { duration }) => Math.max(maximum, duration), 0),
      commitsToPaint,
      commitsToSettled: bench.commits.filter(({ t }) => t >= startedAt && t <= settledAt).length,
      loadedTurns,
      renderedRows: document.querySelectorAll(".response-virtual-item, .response-static-item").length,
      censusCommits: bench.census ? bench.commits.slice(commitStart) : [],
    };
  }, { title, marker });
}

async function loadOlderPage(page: Page): Promise<OlderPageSample | null> {
  return await page.evaluate(async () => {
    const bench = Reflect.get(window, "__contentBench") as {
      log: FrameRecord[]; longTasks: { start: number; duration: number }[]; commits: CommitRecord[]; census: boolean;
    };
    const nextFrame = () => new Promise<number>((resolveFrame) => requestAnimationFrame(resolveFrame));
    const scroller = document.querySelector<HTMLElement>(".message-scroll");
    if (!scroller) throw new Error("Transcript is missing.");
    const turns = () => {
      const feed = document.querySelector('[role="feed"][aria-label$=" conversation turns"]');
      return feed
        ? Number(/^(\d+) conversation turns$/u.exec(feed.getAttribute("aria-label") ?? "")?.[1] ?? 0)
        : document.querySelectorAll(".response-static-item").length;
    };
    const findButton = () => [...scroller.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === "Load earlier messages");
    let button = findButton();
    for (let attempt = 0; attempt < 120 && (!button || scroller.scrollTop > 0); attempt += 1) {
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
      scroller.scrollTop = 0;
      await nextFrame();
      button = findButton();
    }
    if (!button) return null;
    for (let frame = 0; frame < 6; frame += 1) await nextFrame();
    const viewportTop = scroller.getBoundingClientRect().top;
    const rows = [...scroller.querySelectorAll<HTMLElement>(".response-virtual-item, .response-static-item")];
    const anchorRow = rows.find((row) => row.getBoundingClientRect().bottom > button!.getBoundingClientRect().bottom + 8);
    const fingerprint = anchorRow?.textContent?.slice(0, 120) ?? null;
    const anchorTop = () => {
      if (!fingerprint) return null;
      const row = [...scroller.querySelectorAll<HTMLElement>(".response-virtual-item, .response-static-item")]
        .find((candidate) => candidate.textContent?.slice(0, 120) === fingerprint);
      return row ? row.getBoundingClientRect().top - viewportTop : null;
    };
    const initialTop = anchorTop();
    const before = turns();
    const logStart = bench.log.length;
    const commitStart = bench.commits.length;
    const startedAt = performance.now();
    button.click();
    let countAt: number | null = null;
    let previousFrame = startedAt;
    let maxFrameMs = 0;
    let longFrameCount = 0;
    let shiftMax = 0;
    let stableFrames = 0;
    let lastTop: number | null = null;
    let settledAt = startedAt;
    while (performance.now() - startedAt < 30_000) {
      const frameAt = await nextFrame();
      const interval = frameAt - previousFrame;
      previousFrame = frameAt;
      maxFrameMs = Math.max(maxFrameMs, interval);
      if (interval > 50) longFrameCount += 1;
      if (countAt === null && turns() > before) countAt = performance.now();
      if (countAt === null) continue;
      const top = anchorTop();
      if (top !== null && initialTop !== null) shiftMax = Math.max(shiftMax, Math.abs(top - initialTop));
      stableFrames = top !== null && lastTop !== null && Math.abs(top - lastTop) < 0.5 ? stableFrames + 1 : 0;
      lastTop = top;
      const lastCommit = bench.commits.at(-1)?.t ?? 0;
      if (stableFrames >= 10 && performance.now() - lastCommit > 300) { settledAt = performance.now(); break; }
      settledAt = performance.now();
    }
    if (countAt === null) throw new Error("Earlier messages never arrived.");
    const frames = bench.log.slice(logStart);
    const request = frames.find((frame) => frame.direction === "out" && frame.types.includes("conversation.detail.load"));
    const result = frames.find((frame) => frame.direction === "in" && frame.kind === "conversation.detail");
    const tasks = bench.longTasks.filter(({ start }) => start >= startedAt && start <= settledAt);
    const finalTop = anchorTop();
    return {
      clickToResultMs: result ? result.t - startedAt : null,
      clickToCountMs: countAt - startedAt,
      clickToSettledMs: settledAt - startedAt,
      requestToResultMs: request && result ? result.t - request.t : null,
      resultToCountMs: result ? countAt - result.t : null,
      resultBytes: result?.bytes ?? null,
      turnsBefore: before,
      turnsAfter: turns(),
      anchorShiftMaxPx: shiftMax,
      anchorShiftFinalPx: finalTop !== null && initialTop !== null ? finalTop - initialTop : Number.NaN,
      longFrameCount,
      maxFrameMs,
      longTaskTotalMs: tasks.reduce((total, { duration }) => total + duration, 0),
      longTaskMaxMs: tasks.reduce((maximum, { duration }) => Math.max(maximum, duration), 0),
      commits: bench.commits.length - commitStart,
      censusCommits: bench.census ? bench.commits.slice(commitStart) : [],
    };
  });
}

async function profile<T>(page: Page, name: string | null, operation: () => Promise<T>): Promise<T> {
  if (!name) return await operation();
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 200 });
  await session.send("Profiler.start");
  try {
    return await operation();
  } finally {
    const { profile: cpuProfile } = await session.send("Profiler.stop");
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(profileDirectory, `${name}.cpuprofile`), JSON.stringify(cpuProfile));
    await session.detach();
  }
}

async function runLaunch(root: string, seed: string, workspace: string, fixture: ContentLoadingFixture,
  index: number, instrumented: boolean): Promise<LaunchResult> {
  const dataDirectory = join(root, `data-${index}`);
  await cp(seed, dataDirectory, { recursive: true });
  const providerBin = join(root, "provider-bin");
  await mkdir(providerBin, { recursive: true });
  const loadBefore = loadavg();
  let electronApp: ElectronApplication | null = null;
  try {
    const launched = await launch(dataDirectory, workspace, join(root, `profile-${index}`), providerBin);
    electronApp = launched.electronApp;
    const { page } = launched;
    await settleIdle(page);
    const initialFrames = await page.evaluate(() =>
      (Reflect.get(window, "__contentBench") as { log: FrameRecord[] }).log
        .filter(({ direction }) => direction === "in").map(({ types, bytes }) => ({ types, bytes })));
    if (instrumented) await page.evaluate(() => (Reflect.get(window, "__contentBench") as { enableCensus(): void }).enableCensus());
    const open: LaunchResult["open"] = [];
    const opened = new Set<ContentLoadingChatSize>([50]);
    for (let cycle = 0; cycle <= WARM_CYCLES; cycle += 1) {
      for (const size of OPEN_ORDER) {
        const chat = fixture.chats[size];
        const cold = !opened.has(size);
        const sample = await profile(page, instrumented && cycle === 0 ? `open-${size}-cold` : null,
          () => openChat(page, chat.title, chat.lastAnswerMarker));
        opened.add(size);
        open.push({ size, cold, sample });
        await settleIdle(page);
      }
    }
    const large = fixture.chats[2_000];
    await openChat(page, large.title, large.lastAnswerMarker);
    await settleIdle(page);
    const older: OlderPageSample[] = [];
    for (let pageIndex = 0; pageIndex < OLDER_PAGES; pageIndex += 1) {
      const name = instrumented && [0, 1, 2, OLDER_PAGES - 2, OLDER_PAGES - 1].includes(pageIndex) ? `older-page-${pageIndex + 1}` : null;
      const sample = await profile(page, name, () => loadOlderPage(page));
      if (!sample) break;
      older.push(sample);
      await settleIdle(page);
    }
    let reopenAfterOlder: LaunchResult["reopenAfterOlder"] = null;
    if (older.length) {
      const turnsBeforeSwitch = older.at(-1)!.turnsAfter;
      const small = fixture.chats[300];
      await openChat(page, small.title, small.lastAnswerMarker);
      await settleIdle(page);
      const reopen = await openChat(page, large.title, large.lastAnswerMarker);
      reopenAfterOlder = { turnsBeforeSwitch, turnsAfterReopen: reopen.loadedTurns, reopenMs: reopen.clickToVisibleMs };
    }
    return { startupMs: launched.startupMs, loadBefore, loadAfter: loadavg(), initialFrames, open, older, reopenAfterOlder };
  } finally {
    if (electronApp) await closeApp(electronApp);
  }
}

function summarizeOpen(launches: LaunchResult[]) {
  const result: Record<string, unknown> = {};
  for (const size of CONTENT_LOADING_CHAT_MESSAGES) {
    for (const cold of [true, false]) {
      const samples = launches.flatMap(({ open }) => open.filter((entry) => entry.size === size && entry.cold === cold)).map(({ sample }) => sample);
      if (!samples.length) continue;
      const phase = (key: string) => distribution(samples.flatMap(({ phases }) => phases[key] === null || phases[key] === undefined ? [] : [phases[key]!]));
      result[`${size}-${cold ? "cold" : "warm"}`] = {
        clickToVisibleMs: distribution(samples.map(({ clickToVisibleMs }) => clickToVisibleMs)),
        clickToSettledMs: distribution(samples.map(({ clickToSettledMs }) => clickToSettledMs)),
        selectSentMs: phase("selectSentMs"),
        snapshotReceivedMs: phase("snapshotReceivedMs"),
        snapshotToDetailRequestMs: phase("snapshotToDetailRequestMs"),
        detailRequestSentMs: phase("detailRequestSentMs"),
        detailRoundTripMs: phase("detailRoundTripMs"),
        resultToVisibleMs: phase("resultToVisibleMs"),
        longTaskTotalMs: distribution(samples.map(({ longTaskTotalMs }) => longTaskTotalMs)),
        longTaskMaxMs: distribution(samples.map(({ longTaskMaxMs }) => longTaskMaxMs)),
        commitsToPaint: distribution(samples.map(({ commitsToPaint }) => commitsToPaint)),
        commitsToSettled: distribution(samples.map(({ commitsToSettled }) => commitsToSettled)),
        loadedTurns: samples[0]!.loadedTurns,
        mountedRows: distribution(samples.map(({ renderedRows }) => renderedRows)),
        rawClickToVisibleMs: samples.map(({ clickToVisibleMs }) => Number(clickToVisibleMs.toFixed(1))),
      };
    }
  }
  return result;
}

function summarizeOlder(launches: LaunchResult[]) {
  const pages = Math.max(0, ...launches.map(({ older }) => older.length));
  const metric = (samples: OlderPageSample[], key: keyof OlderPageSample) =>
    distribution(samples.flatMap((sample) => typeof sample[key] === "number" && Number.isFinite(sample[key]) ? [sample[key] as number] : []));
  const all = launches.flatMap(({ older }) => older);
  const keys: (keyof OlderPageSample)[] = ["clickToCountMs", "clickToSettledMs", "requestToResultMs", "resultToCountMs",
    "resultBytes", "anchorShiftMaxPx", "anchorShiftFinalPx", "maxFrameMs", "longFrameCount", "longTaskTotalMs", "longTaskMaxMs", "commits"];
  return {
    allPages: Object.fromEntries(keys.map((key) => [key, metric(all, key)])),
    perPage: Array.from({ length: pages }, (_, index) => {
      const samples = launches.flatMap(({ older }) => older[index] ? [older[index]!] : []);
      return { page: index + 1, turnsBefore: samples[0]?.turnsBefore, turnsAfter: samples[0]?.turnsAfter,
        ...Object.fromEntries(keys.map((key) => [key, metric(samples, key)])) };
    }),
  };
}

test("records chat open and older-history paging costs", async () => {
  test.setTimeout((LAUNCHES + 1) * 300_000);
  const root = await mkdtemp(join(tmpdir(), "inertia-content-desktop-"));
  try {
    const workspace = join(root, "workspace");
    const seed = join(root, "seed");
    await mkdir(workspace, { recursive: true });
    await initializeContentLoadingWorkspace(workspace);
    const fixture = await seedContentLoadingRuntime(seed, workspace);
    const launches: LaunchResult[] = [];
    for (let index = 0; index < LAUNCHES; index += 1) {
      launches.push(await runLaunch(root, seed, workspace, fixture, index, false));
    }
    const instrumented = INSTRUMENTED ? await runLaunch(root, seed, workspace, fixture, LAUNCHES, true) : null;
    const report = {
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model,
      launches: LAUNCHES,
      warmCycles: WARM_CYCLES,
      fixture,
      startupMs: distribution(launches.map(({ startupMs }) => startupMs)),
      load: launches.map(({ loadBefore, loadAfter }) => ({ before: loadBefore, after: loadAfter })),
      initialFrames: launches[0]?.initialFrames,
      open: summarizeOpen(launches),
      older: summarizeOlder(launches),
      reopenAfterOlder: launches.map(({ reopenAfterOlder }) => reopenAfterOlder),
      instrumented: instrumented && {
        open: instrumented.open.map(({ size, cold, sample }) => ({ size, cold, clickToVisibleMs: sample.clickToVisibleMs,
          frames: sample.frames, censusCommits: sample.censusCommits })),
        older: instrumented.older.map(({ censusCommits, clickToCountMs, clickToSettledMs, turnsBefore }) =>
          ({ turnsBefore, clickToCountMs, clickToSettledMs, censusCommits })),
      },
      raw: launches,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Content loading desktop report: ${reportPath}`);
    expect(launches).toHaveLength(LAUNCHES);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
