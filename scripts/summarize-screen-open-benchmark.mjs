import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const directory = resolve(process.argv[2] ?? "performance-results/screen-open");
const assetDirectory = resolve(process.argv[3] ?? "out/renderer/assets");

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(1));
}

function distribution(values) {
  return {
    n: values.length,
    median: median(values),
    p95: percentile(values, 0.95),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    raw: values,
  };
}

function summarizeRuns() {
  const runs = readdirSync(directory)
    .filter((name) => /^run-\d+\.json$/u.test(name))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
    .sort((left, right) => left.run - right.run);
  if (runs.length === 0) return null;
  const ids = [...new Set(runs.flatMap((run) => run.steps.map((step) => step.id)))];
  const steps = ids.map((id) => {
    const entries = runs.map((run) => run.steps.find((step) => step.id === id)).filter(Boolean);
    const phase = (key) => {
      const samples = entries.map((entry) => entry[key]).filter(Boolean);
      const commandTypes = new Map();
      for (const sample of samples) {
        for (const command of sample.commands) {
          const current = commandTypes.get(command.type) ?? { roundTrips: [], beforePaint: 0, count: 0, bytes: [] };
          current.count += 1;
          if (command.roundTripMs !== null) current.roundTrips.push(command.roundTripMs);
          if (command.responseBytes !== null) current.bytes.push(command.responseBytes);
          if (command.settledBeforePaint) current.beforePaint += 1;
          commandTypes.set(command.type, current);
        }
      }
      return {
        inputToPaintMs: distribution(samples.map((sample) => sample.inputToPaintMs)),
        inputToContentMs: distribution(samples.map((sample) => sample.inputToContentMs)),
        inputToShellMs: distribution(samples.map((sample) => sample.inputToShellMs).filter((value) => value !== null)),
        inputDispatchDelayMs: distribution(samples.map((sample) => sample.inputDispatchDelayMs)),
        longTaskTotalMs: distribution(samples.map((sample) => sample.longTaskTotalMs)),
        longestTaskMs: distribution(samples.map((sample) => sample.longestTaskMs)),
        postPaintLongTaskMs: distribution(samples.map((sample) => sample.postPaintLongTaskMs)),
        receivedBytes: distribution(samples.map((sample) => sample.receivedBytes)),
        commands: Object.fromEntries([...commandTypes].map(([type, value]) => [type, {
          perOpen: Number((value.count / samples.length).toFixed(2)),
          roundTripMs: distribution(value.roundTrips),
          responseBytesMedian: median(value.bytes),
          settledBeforePaint: value.beforePaint,
        }])),
      };
    };
    return {
      id,
      errors: entries.filter((entry) => entry.error).map((entry) => entry.error),
      cold: phase("cold"),
      warm: phase("warm"),
    };
  });
  const detachedPhase = (key) => {
    const samples = runs.map((run) => run.detachedWindow?.[key]).filter((value) => value && typeof value === "object");
    const fields = ["inputToPaintMs", "inputToNavigationStartMs", "navigationToDomContentLoadedMs", "navigationToFirstContentfulPaintMs", "navigationToContentPaintMs"];
    return Object.fromEntries(fields.map((field) => [field, distribution(samples.map((sample) => sample[field]).filter((value) => typeof value === "number"))]));
  };
  return {
    runs: runs.length,
    hosts: runs.map((run) => ({ run: run.run, loadBefore: run.host.loadBefore, loadAfter: run.host.loadAfter })),
    steps,
    detachedWindow: { cold: detachedPhase("cold"), warm: detachedPhase("warm") },
  };
}

function markdownTable(summary) {
  const rows = [
    "| Screen | Cold median | Cold p95 | Warm median | Warm p95 | Cold content (median) | Cold long tasks (median ms) | Awaited commands (cold, median RTT ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  const ordered = [...summary.steps].sort((left, right) =>
    (right.cold.inputToPaintMs.median ?? 0) - (left.cold.inputToPaintMs.median ?? 0));
  for (const step of ordered) {
    const commands = Object.entries(step.cold.commands)
      .map(([type, value]) => `${type} x${value.perOpen} (${value.roundTripMs.median ?? "n/a"})`)
      .join(", ") || "none";
    rows.push(`| ${step.id} | ${step.cold.inputToPaintMs.median} | ${step.cold.inputToPaintMs.p95} | ${step.warm.inputToPaintMs.median} | ${step.warm.inputToPaintMs.p95} | ${step.cold.inputToContentMs.median} | ${step.cold.longTaskTotalMs.median} | ${commands} |`);
  }
  const cold = summary.detachedWindow.cold;
  const warm = summary.detachedWindow.warm;
  rows.push(`| detached-window | ${cold.inputToPaintMs.median} | ${cold.inputToPaintMs.p95} | ${warm.inputToPaintMs.median} | ${warm.inputToPaintMs.p95} | navigation starts ${cold.inputToNavigationStartMs.median}, content ${cold.navigationToContentPaintMs.median} after it | | IPC + new BrowserWindow |`);
  return rows.join("\n");
}

const maps = new Map();
function mapFor(url) {
  if (!url) return null;
  let file;
  try {
    file = url.startsWith("file:") ? fileURLToPath(url) : url;
  } catch {
    return null;
  }
  const mapPath = join(assetDirectory, `${basename(file.split("?")[0])}.map`);
  if (!maps.has(mapPath)) {
    maps.set(mapPath, existsSync(mapPath) ? new TraceMap(readFileSync(mapPath, "utf8")) : null);
  }
  return maps.get(mapPath);
}

function shortSource(source) {
  if (!source) return null;
  const normalized = source.replaceAll("\\", "/");
  const markers = ["/src/", "/node_modules/"];
  for (const marker of markers) {
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
  }
  return normalized.replace(/^(\.\.\/)+/u, "");
}

function resolveFrame(callFrame) {
  const { url, functionName, lineNumber, columnNumber } = callFrame;
  if (!url) return { key: functionName || "(native)", source: functionName || "(native)", name: functionName || "(anonymous)", line: null };
  const map = mapFor(url);
  if (map && lineNumber >= 0) {
    const position = originalPositionFor(map, { line: lineNumber + 1, column: Math.max(0, columnNumber) });
    if (position.source) {
      const source = shortSource(position.source);
      const name = position.name || functionName || "(anonymous)";
      return { key: `${source}:${position.line} ${name}`, source, name, line: position.line };
    }
  }
  const source = basename(url.split("?")[0]);
  return { key: `${source}:${lineNumber + 1}:${columnNumber + 1} ${functionName || "(anonymous)"}`, source, name: functionName || "(anonymous)", line: lineNumber + 1 };
}

function traceEvents(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.traceEvents;
}

const javascriptEvents = new Set([
  "FunctionCall", "EvaluateScript", "v8.evaluateModule", "RunMicrotasks", "TimerFire",
  "EventDispatch", "FireAnimationFrame", "FireIdleCallback", "v8.run", "V8.Execute",
]);
const layoutEvents = new Set(["Layout", "UpdateLayoutTree", "RecalculateStyles"]);

function summarizeTrace(path) {
  const events = traceEvents(path);
  const marks = events.filter((event) => event.cat?.includes("blink.user_timing") && event.name?.startsWith("screen-open:"));
  const input = marks.find((event) => event.name === "screen-open:input");
  const paint = marks.find((event) => event.name === "screen-open:paint");
  if (!input || !paint) return null;
  const pid = input.pid;
  const threadNames = new Map(events
    .filter((event) => event.ph === "M" && event.name === "thread_name" && event.pid === pid)
    .map((event) => [event.tid, event.args?.name]));
  const mainTid = [...threadNames].find(([, name]) => name === "CrRendererMain")?.[0] ?? input.tid;
  const start = Math.min(input.ts, input.args?.data?.startTime ? input.ts : input.ts);
  const end = paint.ts;
  const complete = events
    .filter((event) => event.pid === pid && event.tid === mainTid && event.ph === "X" && typeof event.dur === "number")
    .filter((event) => event.ts + event.dur >= start && event.ts <= end)
    .sort((left, right) => left.ts - right.ts || right.dur - left.dur);
  const selfByName = new Map();
  const stack = [];
  const forced = [];
  for (const event of complete) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= event.ts) stack.pop();
    const clippedStart = Math.max(event.ts, start);
    const clippedEnd = Math.min(event.ts + event.dur, end);
    const duration = Math.max(0, clippedEnd - clippedStart);
    selfByName.set(event.name, (selfByName.get(event.name) ?? 0) + duration);
    const parent = stack[stack.length - 1];
    if (parent) selfByName.set(parent.name, (selfByName.get(parent.name) ?? 0) - duration);
    if (layoutEvents.has(event.name) && stack.some((ancestor) => javascriptEvents.has(ancestor.name))) {
      const frame = event.args?.beginData?.stackTrace?.[0] ?? event.args?.data?.stackTrace?.[0] ?? null;
      forced.push({
        name: event.name,
        ms: duration / 1000,
        at: frame ? resolveFrame({ url: frame.url, functionName: frame.functionName, lineNumber: frame.lineNumber - 1, columnNumber: frame.columnNumber - 1 }).key : null,
      });
    }
    stack.push(event);
  }
  const resources = new Map();
  for (const event of events) {
    if (event.pid !== pid) continue;
    const data = event.args?.data;
    if (!data?.requestId) continue;
    if (event.name === "ResourceSendRequest" && event.ts >= start && event.ts <= end) {
      resources.set(data.requestId, { url: basename(String(data.url).split("?")[0]), sentAt: (event.ts - start) / 1000, finishedAt: null });
    } else if (event.name === "ResourceFinish" && resources.has(data.requestId)) {
      resources.get(data.requestId).finishedAt = (event.ts - start) / 1000;
    }
  }
  const forcedByCaller = new Map();
  for (const item of forced) {
    const key = `${item.name} @ ${item.at ?? "unknown"}`;
    const current = forcedByCaller.get(key) ?? { count: 0, ms: 0 };
    current.count += 1;
    current.ms += item.ms;
    forcedByCaller.set(key, current);
  }
  return {
    windowMs: Number(((end - start) / 1000).toFixed(1)),
    window: { start, end },
    mainThreadSelfMs: Object.fromEntries([...selfByName]
      .map(([name, value]) => [name, Number((value / 1000).toFixed(1))])
      .filter(([, value]) => value >= 0.5)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)),
    forcedLayouts: {
      count: forced.length,
      ms: Number(forced.reduce((total, item) => total + item.ms, 0).toFixed(1)),
      byCaller: [...forcedByCaller]
        .map(([key, value]) => ({ key, count: value.count, ms: Number(value.ms.toFixed(1)) }))
        .sort((left, right) => right.ms - left.ms)
        .slice(0, 8),
    },
    resources: [...resources.values()].map((resource) => ({
      url: resource.url,
      sentAtMs: Number(resource.sentAt.toFixed(1)),
      finishedAtMs: resource.finishedAt === null ? null : Number(resource.finishedAt.toFixed(1)),
    })),
  };
}

function summarizeProfile(path, window) {
  const profile = JSON.parse(readFileSync(path, "utf8"));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const resolved = new Map();
  const frameOf = (id) => {
    if (!resolved.has(id)) resolved.set(id, resolveFrame(nodes.get(id).callFrame));
    return resolved.get(id);
  };
  const selfByFunction = new Map();
  const selfBySource = new Map();
  const inclusiveBySource = new Map();
  let time = profile.startTime;
  let total = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    time += profile.timeDeltas[index] ?? 0;
    const next = index + 1 < profile.timeDeltas.length ? profile.timeDeltas[index + 1] : 0;
    if (window && (time < window.start || time > window.end)) continue;
    const duration = Math.max(0, next) / 1000;
    const id = profile.samples[index];
    const frame = frameOf(id);
    if (frame.source === "(idle)") continue;
    total += duration;
    selfByFunction.set(frame.key, (selfByFunction.get(frame.key) ?? 0) + duration);
    selfBySource.set(frame.source, (selfBySource.get(frame.source) ?? 0) + duration);
    const seen = new Set();
    for (let current = id; current !== undefined; current = parents.get(current)) {
      const source = frameOf(current).source;
      if (!source?.startsWith("src/") || seen.has(source)) continue;
      seen.add(source);
      inclusiveBySource.set(source, (inclusiveBySource.get(source) ?? 0) + duration);
    }
  }
  const top = (map, count) => [...map]
    .sort((left, right) => right[1] - left[1])
    .slice(0, count)
    .map(([key, value]) => ({ key, ms: Number(value.toFixed(1)), share: total ? Number((value / total).toFixed(3)) : 0 }));
  return {
    sampledBusyMs: Number(total.toFixed(1)),
    topSelfFunctions: top(selfByFunction, 20),
    topSelfSources: top(selfBySource, 15),
    topInclusiveAppSources: top(inclusiveBySource, 20),
  };
}

function summarizeProfiles() {
  const profileDirectory = join(directory, "profiles");
  if (!existsSync(profileDirectory)) return null;
  const names = readdirSync(profileDirectory)
    .filter((name) => name.endsWith(".cpuprofile"))
    .map((name) => name.slice(0, -".cpuprofile".length))
    .sort();
  const result = {};
  for (const name of names) {
    const tracePath = join(profileDirectory, `${name}.trace.json`);
    const trace = existsSync(tracePath) ? summarizeTrace(tracePath) : null;
    result[name] = {
      trace,
      profile: summarizeProfile(join(profileDirectory, `${name}.cpuprofile`), trace?.window ?? null),
    };
  }
  return result;
}

function gitProcesses(path) {
  const processes = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.event === "start") {
      processes.set(event.sid, { startedAt: Date.parse(event.time), argv: event.argv.slice(1).join(" "), ms: null });
    } else if (event.event === "exit" && processes.has(event.sid)) {
      processes.get(event.sid).ms = Number((event.t_abs * 1000).toFixed(1));
    }
  }
  return [...processes.values()].sort((left, right) => left.startedAt - right.startedAt);
}

function summarizeGitTraces() {
  const traceDirectory = existsSync(join(directory, "profiles")) ? join(directory, "profiles") : directory;
  const traces = readdirSync(traceDirectory).filter((name) => /^run-\d+-git-trace2\.jsonl$/u.test(name));
  const result = {};
  for (const name of traces) {
    const run = Number(/run-(\d+)/u.exec(name)[1]);
    const reportPath = join(traceDirectory, `run-${run}.json`);
    if (!existsSync(reportPath)) continue;
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const processes = gitProcesses(join(traceDirectory, name));
    const samples = report.steps.flatMap((step) => ["cold", "warm"]
      .filter((phase) => step[phase])
      .map((phase) => ({ id: `${step.id}-${phase}`, inputAt: step[phase].inputAtEpochMs, paintAt: step[phase].paintAtEpochMs })))
      .sort((left, right) => left.inputAt - right.inputAt);
    result[`run-${run}`] = Object.fromEntries(samples.map((sample, index) => {
      const end = Math.min(samples[index + 1]?.inputAt ?? Infinity, sample.inputAt + 5_000);
      const inside = processes.filter((process) => process.startedAt >= sample.inputAt && process.startedAt < end);
      return [sample.id, {
        count: inside.length,
        totalMs: Number(inside.reduce((total, process) => total + (process.ms ?? 0), 0).toFixed(1)),
        lastExitAfterInputMs: inside.length
          ? Number(Math.max(...inside.map((process) => process.startedAt + (process.ms ?? 0) - sample.inputAt)).toFixed(1))
          : null,
        processes: inside.map((process) => ({
          argv: process.argv.slice(0, 120),
          startAfterInputMs: Number((process.startedAt - sample.inputAt).toFixed(1)),
          ms: process.ms,
        })),
      }];
    }));
  }
  return result;
}

const runs = summarizeRuns();
const profiles = summarizeProfiles();
const git = summarizeGitTraces();
const output = { directory, runs, profiles, git };
writeFileSync(join(directory, "summary.json"), `${JSON.stringify(output, null, 2)}\n`);
if (runs) {
  writeFileSync(join(directory, "summary.md"), `${markdownTable(runs)}\n`);
  console.log(markdownTable(runs));
}
console.log(`Screen-open summary: ${join(directory, "summary.json")}`);
