import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// Diagnostic-only renderer timeline. Long-animation-frame entries provide
// bounded script attribution without enabling global Chromium/system tracing.
// This cannot identify native/GC stacks or external scheduling contention.
export async function startBoundedStreamingTimeline(page: Page, directory: string) {
  const errors: string[] = [];
  const bounded = async <T>(operation: Promise<T>, label: string): Promise<T | null> => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(label)), 1_000);
        }),
      ]);
    } catch { errors.push(label); return null; }
    finally { if (deadline) clearTimeout(deadline); }
  };
  await bounded(page.evaluate(() => {
    const entries: Record<string, unknown>[] = [];
    const supported = PerformanceObserver.supportedEntryTypes.includes("long-animation-frame");
    const startedAt = performance.now();
    let bytes = 0;
    let dropped = 0;
    let stoppedAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: PerformanceObserver | undefined;
    const numberField = (value: object, key: string) => {
      const item = Reflect.get(value, key);
      return typeof item === "number" && Number.isFinite(item) ? item : null;
    };
    const collect = (list: PerformanceObserverEntryList) => {
      for (const entry of list.getEntries()) {
        if (entries.length >= 128 || bytes >= 512 * 1_024) { dropped += 1; continue; }
        const record: Record<string, unknown> = {};
        for (const key of ["startTime", "duration", "blockingDuration", "renderStart", "styleAndLayoutStart", "firstUIEventTimestamp"]) {
          record[key] = numberField(entry, key);
        }
        const scripts: unknown = Reflect.get(entry, "scripts");
        record.scripts = Array.isArray(scripts) ? scripts.slice(0, 8).map((script: unknown) => {
          if (typeof script !== "object" || script === null) return {};
          const item: Record<string, unknown> = {};
          for (const key of ["startTime", "duration", "executionStart", "forcedStyleAndLayoutDuration", "pauseDuration", "sourceCharPosition"]) item[key] = numberField(script, key);
          for (const key of ["invokerType", "sourceFunctionName"]) {
            const field: unknown = Reflect.get(script, key);
            item[key] = typeof field === "string" ? field.slice(0, 120) : null;
          }
          return item;
        }) : [];
        const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
        if (bytes + size > 512 * 1_024) { dropped += 1; continue; }
        entries.push(record); bytes += size;
      }
    };
    const stop = () => {
      if (stoppedAt === null) stoppedAt = performance.now();
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      return { supported, startedAt, stoppedAt, timeOrigin: performance.timeOrigin, bytes, dropped, entries };
    };
    if (supported) {
      observer = new PerformanceObserver(collect);
      observer.observe({ entryTypes: ["long-animation-frame"] });
    }
    Reflect.set(globalThis, "__inertiaStreamingDiagnostic", stop);
    timer = setTimeout(stop, 10_000);
  }), "timeline-start-unconfirmed");
  return async () => {
    const timeline = await bounded(page.evaluate(() => {
      const stop: unknown = Reflect.get(globalThis, "__inertiaStreamingDiagnostic");
      Reflect.deleteProperty(globalThis, "__inertiaStreamingDiagnostic");
      return typeof stop === "function" ? stop() as unknown : null;
    }), "timeline-stop-unconfirmed");
    await writeFile(join(directory, "streaming-first-sample-timeline.json"), JSON.stringify({
      diagnosticOnly: true, errors, timeline,
      limits: { windowMs: 10_000, entries: 128, scriptsPerEntry: 8, entryBytes: 512 * 1_024 },
      limitations: "Instrumentation adds overhead. Renderer-only long-animation-frame entries may omit native/GC work and do not provide CPU stacks. Unsupported/timeout/truncated capture is explicit. A clean diagnostic run proves neither source repair nor runner noise.",
    }), { mode: 0o600 });
  };
}
