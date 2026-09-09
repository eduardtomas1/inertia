import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { CDPSession, Page } from "@playwright/test";

// Diagnostic-ref only. The pristine baseline does not import this harness.
const TRACE_BYTES = 48 * 1024 * 1024;
const CPU_BYTES = 8 * 1024 * 1024;
const CAPTURE_MS = 355_000;
const RPC_MS = 4_000;
const RUNTIME_FUNCTIONS = new Set(["(idle)", "(program)", "(garbage collector)", "samplePaint"]);
const METRICS = new Set([
  "Timestamp", "ThreadTime", "ProcessTime", "TaskDuration", "ScriptDuration",
  "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount",
  "JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "Documents",
]);

export function profileAssetPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const path = new URL(value).pathname;
    const match = /\/assets\/([A-Za-z0-9_.-]+\.(?:js|css))$/u.exec(path);
    return match ? `/assets/${match[1]}` : null;
  } catch { return null; }
}

export function profileFunctionName(name: string, asset: string | null): string {
  return asset ? name.slice(0, 160) : RUNTIME_FUNCTIONS.has(name) ? name : "<runtime>";
}

export function profileTraceEvent(value: Record<string, unknown>) {
  const name = typeof value.name === "string" ? value.name : "";
  if (!/^(?:.*RunTask|RunMicrotasks|FunctionCall|EvaluateScript|CompileScript|Layout|UpdateLayoutTree|RecalculateStyles|Paint|PrePaint|CompositeLayers|MinorGC|MajorGC|V8\..*|v8\..*|thread_name|process_name|inertia-profile:.*|inertia-stream:.*)$/u.test(name)) return null;
  const event: Record<string, unknown> = { name: name.slice(0, 180) };
  for (const key of ["ts", "dur", "tts", "tdur", "pid", "tid"]) {
    if (typeof value[key] === "number") event[key] = value[key];
  }
  if (typeof value.ph === "string") event.ph = value.ph.slice(0, 1);
  const args = value.args as Record<string, unknown> | undefined;
  const data = (args?.data ?? args?.beginData ?? args) as Record<string, unknown> | undefined;
  const safe: Record<string, unknown> = {};
  for (const key of ["usedHeapSizeBefore", "usedHeapSizeAfter", "heapSize", "totalObjects", "dirtyObjects", "lineNumber", "columnNumber"]) {
    if (typeof data?.[key] === "number") safe[key] = data[key];
  }
  const asset = profileAssetPath(data?.url ?? data?.scriptName);
  if (asset) safe.asset = asset;
  if (name === "thread_name" || name === "process_name") {
    const thread = args?.name;
    if (typeof thread === "string" && /^[A-Za-z0-9_. -]{1,80}$/u.test(thread)) safe.name = thread;
  }
  event.args = safe;
  return event;
}

export interface IntelBenchmarkProfile {
  mark: (label: string) => Promise<void>;
  stop: (reason?: string) => Promise<void>;
}

export async function startIntelBenchmarkProfile(page: Page): Promise<IntelBenchmarkProfile | null> {
  const directory = process.env.INERTIA_V55_INTEL_PROFILE_DIR;
  if (!directory) return null;
  const output = resolve(directory);
  mkdirSync(output, { recursive: true });
  const tracePath = join(output, "renderer-timeline.json");
  writeFileSync(tracePath, '{"traceEvents":[\n');
  let bytes = 18;
  let eventCount = 0;
  let traceClosed = false;
  let stopped: Promise<void> | null = null;
  let session: CDPSession | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let traceStarted = false;
  let cpuStarted = false;
  const faults: string[] = [];
  const phases: unknown[] = [];
  const started = performance.now();
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    source: "71652cccc8c2e1cb6cee6c79c60fe4bde55440c6",
    limits: { captureMs: CAPTURE_MS, traceBytes: TRACE_BYTES, cpuBytes: CPU_BYTES },
    limitations: [
      "Profiling, phase RPCs and synchronous bounded trace writes add overhead; use the separate pristine baseline for benchmark results.",
      "Capture starts after firstWindow; buffered asset ResourceTiming may precede attachment, but earlier CPU work is unavailable.",
      "Asset load/evaluation boundaries do not prove the private React lazy/preload promise settled.",
      "CDP CPU sampling is renderer-only; task thread-time fields and Performance threadTicks are retained when Chromium exposes them.",
    ],
  };
  const bounded = async <T>(label: string, operation: () => Promise<T>): Promise<T | null> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("diagnostic-deadline")), RPC_MS);
        }),
      ]);
    } catch { faults.push(label); return null; }
    finally { if (timeout) clearTimeout(timeout); }
  };
  let traceComplete: Promise<void> = Promise.resolve();

  const profile: IntelBenchmarkProfile = {
    mark: async (label) => {
      if (stopped || !session || phases.length >= 128) return;
      if (!/^[a-z0-9-]{1,80}$/u.test(label)) { faults.push("invalid-phase"); return; }
      const before = performance.now();
      const marker = await bounded("phase-marker", () => page.evaluate((name) => {
        performance.mark(`inertia-profile:${name}`);
        return { rendererMs: performance.now(), wallTimeMs: Date.now() };
      }, label));
      const metrics = await bounded("phase-metrics", () => session!.send("Performance.getMetrics"));
      phases.push({ label, driverMs: before - started, rpcWallMs: performance.now() - before,
        marker, metrics: metrics?.metrics?.filter((m: { name: string }) => METRICS.has(m.name)) ?? null });
    },
    stop: (reason = "samples-complete") => {
      if (stopped) return stopped;
      stopped = (async () => {
        if (timer) clearTimeout(timer);
        report.stopReason = reason;
        report.captureWallMs = performance.now() - started;
        if (reason !== "samples-complete" && reason !== "test-finally") faults.push(reason);
        // End both recording domains immediately; observer reads and file writes
        // happen after capture, including when the watchdog wins.
        const [, result] = await Promise.all([
          traceStarted ? bounded("trace-end", () => session!.send("Tracing.end")) : null,
          cpuStarted ? bounded("cpu-stop", () => session!.send("Profiler.stop")) : null,
        ]);
        if (traceStarted) await bounded("trace-completion", () => traceComplete);
        if (cpuStarted) {
          if (result?.profile) {
            const cpu = result.profile;
            for (const node of cpu.nodes) {
              const frame = node.callFrame;
              const asset = profileAssetPath(frame.url);
              node.callFrame = { ...frame, url: asset ?? "", functionName: profileFunctionName(frame.functionName, asset) };
              delete node.deoptReason;
            }
            const encoded = JSON.stringify(cpu);
            if (Buffer.byteLength(encoded) <= CPU_BYTES) writeFileSync(join(output, "renderer.cpuprofile"), encoded);
            else faults.push("cpu-size-limit");
          } else faults.push("cpu-missing");
        }
        report.renderer = await bounded("renderer-observers", () => page.evaluate(() => {
          const state = Reflect.get(globalThis, "__inertiaIntelProfile") as {
            stop: () => { truncated: boolean };
          } | undefined;
          return state?.stop() ?? null;
        }));
        if ((report.renderer as { truncated?: boolean } | null)?.truncated) faults.push("observer-size-limit");
        await bounded("session-detach", async () => { await session?.detach(); });
        traceClosed = true;
        appendFileSync(tracePath, "\n]}\n");
        report.traceEvents = eventCount;
        report.traceBytes = bytes;
        report.phases = phases;
        report.faults = faults;
        report.complete = faults.length === 0 && eventCount > 0 && report.renderer !== null;
        writeFileSync(join(output, "profile-receipt.json"), JSON.stringify(report, null, 2));
      })().catch(() => {
        traceClosed = true;
        faults.push("profile-write-failed");
        try { writeFileSync(join(output, "profile-receipt.json"), JSON.stringify({ ...report, complete: false, faults })); }
        catch { /* The workflow rejects a missing receipt. Cleanup still runs. */ }
      });
      return stopped;
    },
  };

  timer = setTimeout(() => { void profile.stop("duration-limit"); }, CAPTURE_MS);
  session = await bounded("session-create", () => page.context().newCDPSession(page));
  if (!session) { await profile.stop("setup-failed"); return profile; }
  traceComplete = new Promise<void>((resolveComplete) => {
    session!.once("Tracing.tracingComplete", () => resolveComplete());
  });
  session.on("Tracing.dataCollected", ({ value }: { value: Record<string, unknown>[] }) => {
    if (traceClosed) return;
    let chunk = "";
    for (const item of value) {
      const event = profileTraceEvent(item);
      if (!event) continue;
      const line = `${eventCount ? ",\n" : ""}${JSON.stringify(event)}`;
      const length = Buffer.byteLength(line);
      if (bytes + length > TRACE_BYTES) {
        if (!faults.includes("trace-size-limit")) faults.push("trace-size-limit");
        void profile.stop("trace-size-limit");
        break;
      }
      chunk += line;
      bytes += length;
      eventCount += 1;
    }
    if (chunk) {
      try { appendFileSync(tracePath, chunk); }
      catch { faults.push("trace-write-failed"); void profile.stop("trace-write-failed"); }
    }
  });
  await bounded("performance-enable", () => session!.send("Performance.enable", { timeDomain: "threadTicks" }));
  await bounded("profiler-enable", () => session!.send("Profiler.enable"));
  await bounded("profiler-interval", () => session!.send("Profiler.setSamplingInterval", { interval: 4_000 }));
  cpuStarted = await bounded("profiler-start", async () => { await session!.send("Profiler.start"); return true; }) ?? false;
  traceStarted = await bounded("trace-start", async () => {
    await session!.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: {
      recordMode: "recordContinuously", includedCategories: ["toplevel", "devtools.timeline", "v8", "disabled-by-default-v8.gc", "blink.user_timing"],
    } });
    return true;
  }) ?? false;
  await bounded("renderer-observer-start", () => page.evaluate(() => {
    const tasks: unknown[] = [];
    let truncated = false;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (tasks.length >= 2048) { truncated = true; break; }
        const task = entry as PerformanceEntry & { attribution?: Array<{ name: string; containerType: string }> };
        tasks.push({ startTime: task.startTime, duration: task.duration, name: task.name,
          attribution: task.attribution?.map((a) => ({ name: a.name, containerType: a.containerType })) });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    Reflect.set(globalThis, "__inertiaIntelProfile", { stop: () => {
      observer.disconnect();
      const assets = performance.getEntriesByType("resource").flatMap((entry) => {
        const resource = entry as PerformanceResourceTiming;
        const match = /\/assets\/([A-Za-z0-9_.-]+\.(?:js|css))$/u.exec(new URL(resource.name).pathname);
        return match ? [{ asset: `/assets/${match[1]}`, startTime: resource.startTime,
          fetchStart: resource.fetchStart, responseStart: resource.responseStart,
          responseEnd: resource.responseEnd, duration: resource.duration,
          transferSize: resource.transferSize, encodedBodySize: resource.encodedBodySize,
          initiatorType: resource.initiatorType }] : [];
      });
      return { timeOrigin: performance.timeOrigin, longTasks: tasks, truncated: truncated || assets.length > 512, assets: assets.slice(0, 512) };
    } });
  }));
  await profile.mark("attached");
  return profile;
}
