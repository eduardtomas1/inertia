import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const [directoryArgument, appRootArgument] = process.argv.slice(2);
if (!directoryArgument) {
  console.error("Usage: node tests/performance/analyze-scroll-profile.mjs <profile directory> [app root]");
  process.exit(2);
}
const directory = resolve(directoryArgument);
const appRoot = resolve(appRootArgument ?? ".");
const assetsDirectory = join(appRoot, "out", "renderer", "assets");
const traceMaps = new Map();

function round(value, digits = 1) {
  return Number(value.toFixed(digits));
}

function traceMapFor(url) {
  if (!url) return null;
  const name = basename(url.split("?")[0]);
  if (traceMaps.has(name)) return traceMaps.get(name);
  const path = join(assetsDirectory, `${name}.map`);
  const map = existsSync(path) ? new TraceMap(readFileSync(path, "utf8")) : null;
  traceMaps.set(name, map);
  return map;
}

function sourceLocation(url, lineNumber, columnNumber) {
  const map = traceMapFor(url);
  if (!map || lineNumber < 0) return null;
  const position = originalPositionFor(map, { line: lineNumber + 1, column: Math.max(0, columnNumber) });
  if (!position.source) return null;
  const source = position.source.replace(/^(\.\.\/)+/u, "");
  return `${source}:${position.line}`;
}

function bucketFor(location, url, functionName) {
  const path = location ?? url ?? "";
  if (!path) return functionName.startsWith("(") ? functionName : "(native)";
  if (path.includes("react-dom") || path.includes("scheduler")) return "react-dom";
  if (/react-markdown|remark|micromark|mdast|hast|unified|vfile|unist|property-information|decode-named|character-entities|rehype|space-separated|comma-separated|html-url-attributes|estree|devlop|bail|trough|zwitch|longest-streak|style-to|inline-style/u.test(path)) return "markdown";
  if (path.includes("highlight.js")) return "highlight.js";
  if (path.includes("@tanstack")) return "tanstack-virtual";
  if (path.includes("src/renderer/src/components/response-timeline")) return "response-timeline";
  if (path.includes("src/renderer/src/components/ResponseMarkdown")) return "ResponseMarkdown";
  if (path.includes("src/renderer/src/components/Sidebar") || path.includes("sidebar")) return "sidebar";
  if (path.includes("src/renderer/src")) return "renderer-other";
  if (path.includes("node_modules")) return `node_modules/${path.split("node_modules/")[1]?.split("/")[0] ?? "?"}`;
  return "bundle-unmapped";
}

function analyzeCpuProfile(path) {
  const profile = JSON.parse(readFileSync(path, "utf8"));
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const selfUs = new Map();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const id = profile.samples[index];
    const delta = profile.timeDeltas[index + 1] ?? 0;
    selfUs.set(id, (selfUs.get(id) ?? 0) + delta);
  }
  const keyOf = (node) => {
    const frame = node.callFrame;
    const location = sourceLocation(frame.url, frame.lineNumber, frame.columnNumber);
    const name = frame.functionName || "(anonymous)";
    return { key: `${name} ${location ?? `${basename(frame.url || "")}:${frame.lineNumber + 1}`}`, name, location, url: frame.url };
  };
  const keys = new Map(profile.nodes.map((node) => [node.id, keyOf(node)]));
  const self = new Map();
  const buckets = new Map();
  let totalUs = 0;
  for (const [id, us] of selfUs) {
    const info = keys.get(id);
    totalUs += us;
    self.set(info.key, (self.get(info.key) ?? 0) + us);
    const bucket = bucketFor(info.location, info.url, info.name);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + us);
  }
  const inclusive = new Map();
  for (const [id, us] of selfUs) {
    const seen = new Set();
    for (let cursor = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const info = keys.get(cursor);
      if (!info || seen.has(info.key)) continue;
      seen.add(info.key);
      inclusive.set(info.key, (inclusive.get(info.key) ?? 0) + us);
    }
  }
  const top = (map, count, filter = () => true) => [...map.entries()]
    .filter(([key]) => filter(key))
    .sort((left, right) => right[1] - left[1])
    .slice(0, count)
    .map(([key, us]) => ({ function: key, ms: round(us / 1000), share: round(us / Math.max(1, totalUs) * 100) }));
  const idleUs = [...self.entries()].filter(([key]) => key.startsWith("(idle)")).reduce((sum, [, us]) => sum + us, 0);
  return {
    totalMs: round(totalUs / 1000),
    busyMs: round((totalUs - idleUs) / 1000),
    buckets: top(buckets, 20, (key) => key !== "(idle)"),
    topSelf: top(self, 40, (key) => !key.startsWith("(idle)")),
    topInclusiveRenderer: top(inclusive, 50, (key) => key.includes("src/renderer/src") || key.includes("@tanstack")),
  };
}

function analyzeTrace(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const events = Array.isArray(raw) ? raw : raw.traceEvents;
  const threadNames = new Map();
  for (const event of events) {
    if (event.ph === "M" && event.name === "thread_name") threadNames.set(`${event.pid}:${event.tid}`, event.args.name);
  }
  const scrollDispatches = new Map();
  for (const event of events) {
    if (event.name === "EventDispatch" && ["scroll", "wheel", "mousemove"].includes(event.args?.data?.type)) {
      const key = `${event.pid}:${event.tid}`;
      scrollDispatches.set(key, (scrollDispatches.get(key) ?? 0) + 1);
    }
  }
  const mainKey = [...scrollDispatches.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
    ?? [...threadNames.entries()].find(([, name]) => name === "CrRendererMain")?.[0];
  const [mainPid] = mainKey.split(":").map(Number);
  const main = events
    .filter((event) => `${event.pid}:${event.tid}` === mainKey && event.ph === "X" && typeof event.dur === "number")
    .sort((left, right) => left.ts - right.ts || right.dur - left.dur);
  const start = main[0]?.ts ?? 0;
  const end = main.reduce((maximum, event) => Math.max(maximum, event.ts + event.dur), start);
  const selfByName = new Map();
  const stack = [];
  const children = new Map();
  for (const event of main) {
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= event.ts) stack.pop();
    const owner = stack.at(-1);
    event.parent = owner ?? null;
    if (owner) {
      owner.childDur = (owner.childDur ?? 0) + event.dur;
      if (!children.has(owner)) children.set(owner, []);
      children.get(owner).push(event);
    }
    stack.push(event);
  }
  const labelOf = (event) => {
    const data = event.args?.data ?? event.args?.beginData ?? {};
    if (event.name === "FunctionCall") return `FunctionCall ${data.functionName || "(anonymous)"} ${sourceLocation(data.url, (data.lineNumber ?? 1) - 1, (data.columnNumber ?? 1) - 1) ?? `${basename(data.url ?? "")}:${data.lineNumber ?? "?"}`}`;
    if (event.name === "EventDispatch") return `EventDispatch ${data.type}`;
    if (event.name === "TimerFire") return "TimerFire";
    return event.name;
  };
  for (const event of main) {
    const selfDur = Math.max(0, event.dur - (event.childDur ?? 0));
    const name = event.name;
    selfByName.set(name, (selfByName.get(name) ?? 0) + selfDur);
  }
  const isTopLevel = (event) => event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask";
  const profilerStartup = (event) => (children.get(event) ?? []).some((child) => child.name === "CpuProfiler::StartProfiling" || profilerStartup(child));
  const tasks = main.filter((event) => isTopLevel(event) && !(event.parent && isTopLevel(event.parent)) && !profilerStartup(event));
  const taskDurations = tasks.map((event) => event.dur / 1000).sort((left, right) => left - right);
  const breakdown = (root) => {
    const totals = new Map();
    const walk = (event) => {
      const selfDur = Math.max(0, event.dur - (event.childDur ?? 0));
      const label = labelOf(event);
      totals.set(label, (totals.get(label) ?? 0) + selfDur);
      for (const child of children.get(event) ?? []) walk(child);
    };
    walk(root);
    const firstCalls = [];
    const visit = (event, depth) => {
      if (event.name === "FunctionCall" || event.name === "EventDispatch" || event.name === "FireAnimationFrame" || event.name === "TimerFire" || event.name === "V8.Execute") {
        if (depth < 6 && event.dur > 2000) firstCalls.push(`${labelOf(event)} ${round(event.dur / 1000)}ms`);
      }
      for (const child of children.get(event) ?? []) visit(child, depth + 1);
    };
    visit(root, 0);
    return {
      selfByLabel: [...totals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([label, dur]) => `${label}: ${round(dur / 1000)}ms`),
      calls: firstCalls.slice(0, 10),
    };
  };
  const longTasks = tasks.filter((event) => event.dur > 50_000).sort((left, right) => right.dur - left.dur);
  const forcedLayouts = new Map();
  const isScripted = (event) => {
    for (let cursor = event.parent; cursor; cursor = cursor.parent) {
      if (["FunctionCall", "EventDispatch", "FireAnimationFrame", "TimerFire", "V8.Execute", "RunMicrotasks", "ResizeObserverController::DeliverObservations"].includes(cursor.name)) return true;
      if (["UpdateLifecycle", "Animation Frame Fired", "PageAnimator::serviceScriptedAnimations"].includes(cursor.name)) return false;
    }
    return false;
  };
  for (const event of main) {
    if (event.name !== "Layout" && event.name !== "UpdateLayoutTree") continue;
    if (!isScripted(event)) continue;
    const stackTrace = event.args?.beginData?.stackTrace ?? event.args?.data?.stackTrace ?? [];
    const frames = stackTrace.slice(0, 3).map((frame) => `${frame.functionName || "(anonymous)"} ${sourceLocation(frame.url, frame.lineNumber - 1, frame.columnNumber - 1) ?? `${basename(frame.url ?? "")}:${frame.lineNumber}`}`);
    const key = `${event.name} <- ${frames.join(" <- ") || "(no stack)"}`;
    const current = forcedLayouts.get(key) ?? { count: 0, us: 0 };
    current.count += 1;
    current.us += event.dur;
    forcedLayouts.set(key, current);
  }
  const allThreads = new Map();
  for (const event of events) {
    if (event.ph !== "X" || typeof event.dur !== "number") continue;
    if (!/Decode|Raster|Paint|Layerize|Composite|Commit|ResizeObserver|IntersectionObserver|ImageDecode/u.test(event.name)) continue;
    const thread = threadNames.get(`${event.pid}:${event.tid}`) ?? "?";
    if (event.pid !== mainPid && !/Viz|Gpu|Compositor|Raster|Tile/u.test(thread)) continue;
    const key = `${event.name} [${thread.replace(/\d+$/u, "")}]`;
    const current = allThreads.get(key) ?? { count: 0, us: 0 };
    current.count += 1;
    current.us += event.dur;
    allThreads.set(key, current);
  }
  const frameEvents = new Map();
  for (const event of events) {
    if (["DrawFrame", "DroppedFrame", "BeginFrame", "BeginMainThreadFrame", "Commit", "ActivateLayerTree", "RequestMainThreadFrame"].includes(event.name)
      && event.ts >= start && event.ts <= end) {
      frameEvents.set(event.name, (frameEvents.get(event.name) ?? 0) + 1);
    }
  }
  const pipeline = new Map();
  for (const event of events) {
    if (event.name !== "PipelineReporter" || event.ph !== "b") continue;
    const state = event.args?.chrome_frame_reporter?.state ?? "unknown";
    pipeline.set(state, (pipeline.get(state) ?? 0) + 1);
  }
  const at = (fraction) => taskDurations[Math.min(taskDurations.length - 1, Math.floor(taskDurations.length * fraction))] ?? 0;
  return {
    mainThread: `${mainKey} ${threadNames.get(mainKey) ?? ""}`,
    windowMs: round((end - start) / 1000),
    tasks: {
      count: tasks.length,
      totalMs: round(tasks.reduce((sum, event) => sum + event.dur, 0) / 1000),
      p50Ms: round(at(0.5), 2),
      p95Ms: round(at(0.95), 2),
      maxMs: round(taskDurations.at(-1) ?? 0, 2),
      over16Ms: taskDurations.filter((value) => value > 16.7).length,
      over50Ms: taskDurations.filter((value) => value > 50).length,
    },
    mainThreadSelfByName: [...selfByName.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30)
      .map(([name, us]) => ({ name, ms: round(us / 1000) })),
    longestTasks: longTasks.slice(0, 8).map((event) => ({
      atMs: round((event.ts - start) / 1000),
      durationMs: round(event.dur / 1000),
      ...breakdown(event),
    })),
    forcedStyleLayout: [...forcedLayouts.entries()].sort((left, right) => right[1].us - left[1].us).slice(0, 15)
      .map(([key, value]) => ({ key, count: value.count, ms: round(value.us / 1000) })),
    renderingWork: [...allThreads.entries()].sort((left, right) => right[1].us - left[1].us).slice(0, 25)
      .map(([key, value]) => ({ key, count: value.count, ms: round(value.us / 1000) })),
    frameEvents: Object.fromEntries(frameEvents),
    pipelineReporterStates: Object.fromEntries(pipeline),
  };
}

function analyzeFrames(path) {
  const frames = JSON.parse(readFileSync(path, "utf8"));
  const scripts = new Map();
  let loafTotal = 0;
  let loafBlocking = 0;
  let styleLayout = 0;
  for (const loaf of frames.longAnimationFrames ?? []) {
    loafTotal += loaf.duration;
    loafBlocking += loaf.blockingDuration ?? 0;
    if (loaf.styleAndLayoutStart) styleLayout += Math.max(0, loaf.startTime + loaf.duration - loaf.styleAndLayoutStart);
    for (const script of loaf.scripts ?? []) {
      const location = script.sourceURL ? `${basename(script.sourceURL)}@${script.sourceCharPosition}` : "";
      const key = `${script.invokerType} ${script.invoker} ${script.sourceFunctionName || ""} ${location}`.trim();
      const current = scripts.get(key) ?? { count: 0, ms: 0, forcedMs: 0 };
      current.count += 1;
      current.ms += script.duration;
      current.forcedMs += script.forcedStyleAndLayoutDuration ?? 0;
      scripts.set(key, current);
    }
  }
  const { intervals: _intervals, longAnimationFrames, extra, ...stats } = frames;
  return {
    stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, typeof value === "number" ? round(value, 2) : value])),
    extra,
    longAnimationFrames: {
      count: longAnimationFrames?.length ?? 0,
      totalMs: round(loafTotal),
      blockingMs: round(loafBlocking),
      styleAndLayoutMs: round(styleLayout),
      topScripts: [...scripts.entries()].sort((left, right) => right[1].ms - left[1].ms).slice(0, 12)
        .map(([key, value]) => ({ key, count: value.count, ms: round(value.ms), forcedStyleLayoutMs: round(value.forcedMs) })),
    },
  };
}

const files = readdirSync(directory);
const passes = [...new Set(files.filter((file) => file.endsWith(".frames.json")).map((file) => file.replace(/\.frames\.json$/u, "")))];
const report = {};
for (const pass of passes) {
  const entry = { frames: analyzeFrames(join(directory, `${pass}.frames.json`)) };
  if (files.includes(`${pass}.cpuprofile`)) entry.cpu = analyzeCpuProfile(join(directory, `${pass}.cpuprofile`));
  if (files.includes(`${pass}.trace.json`)) entry.trace = analyzeTrace(join(directory, `${pass}.trace.json`));
  if (files.includes(`${pass}.commits.json`)) {
    const commits = JSON.parse(readFileSync(join(directory, `${pass}.commits.json`), "utf8"));
    const perCommit = commits.commitTimes.map(([, count]) => count).sort((left, right) => left - right);
    entry.commits = {
      commits: commits.commits,
      traversalMs: commits.traversalMs,
      renderedFibersPerCommit: {
        median: perCommit[Math.floor(perCommit.length / 2)] ?? 0,
        p95: perCommit[Math.floor(perCommit.length * 0.95)] ?? 0,
        max: perCommit.at(-1) ?? 0,
      },
      topRendered: commits.rendered.slice(0, 30),
      topMounted: commits.mounted.slice(0, 20),
    };
  }
  report[pass] = entry;
}
const output = join(directory, "analysis.json");
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${relative(process.cwd(), output)}`);
