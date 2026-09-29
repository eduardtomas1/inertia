import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { test, type ElectronApplication, type Page } from "@playwright/test";

import { electronHelperProcesses, gpuMainThreadStall } from "./electron-main-process-diagnostic";

const execFileAsync = promisify(execFile);
const FRAME_TIMEOUT_MS = 1_000;
const MAIN_PROCESS_REPLY_MS = 3_000;
const MONITOR_INTERVAL_MS = 2_000;
const UNCONFIRMED_STALL_BACKOFF_MS = 30_000;
const MAX_RECOVERIES_PER_APP = 2;
const CONSECUTIVE_STALLED_PROBES = 2;
const PROCESS_TABLE_TIMEOUT_MS = 1_000;
const SAMPLE_TIMEOUT_MS = 6_000;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROBE_WORLD_ID = 7_331;
const PROBE_SOURCE = `new Promise((resolve) => {
  if (document.visibilityState === "hidden") { resolve("hidden"); return; }
  const timer = setTimeout(() => resolve("stalled"), ${FRAME_TIMEOUT_MS});
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve("frames"); }));
})`;

export const GPU_HELPER_STALL_RECOVERED = "electron-gpu-helper-stall-recovered";

export type FrameProbe = "frames" | "idle" | "stalled";

export interface GpuHelperRecovery {
  helper: string;
  sample: string;
}

export interface FrameStallMonitorDependencies {
  probe: () => Promise<FrameProbe>;
  recover: (signal: AbortSignal) => Promise<GpuHelperRecovery | null>;
  record: (recovery: GpuHelperRecovery) => Promise<void>;
}

export interface FrameStallMonitor {
  stop: () => void;
}

export async function renderedFrame(page: Page): Promise<boolean> {
  try {
    return await page.evaluate((timeout) => new Promise<boolean>((resolve) => {
      if (document.visibilityState === "hidden") return resolve(true);
      const timer = setTimeout(() => resolve(false), timeout);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve(true);
      }));
    }), FRAME_TIMEOUT_MS);
  } catch {
    return true;
  }
}

async function runTool(command: string, args: string[], timeout: number, signal: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeout,
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      signal,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function helperIdentity(pid: number, mainPid: number, signal: AbortSignal): Promise<string | null> {
  const identity = (await runTool("/bin/ps", ["-o", "ppid=,lstart=", "-p", String(pid)],
    PROCESS_TABLE_TIMEOUT_MS, signal))?.trim() ?? "";
  return identity.split(/\s+/u)[0] === String(mainPid) ? identity : null;
}

export async function terminateStalledGpuHelper(mainPid: number, signal: AbortSignal): Promise<GpuHelperRecovery | null> {
  const table = await runTool("/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,command="],
    PROCESS_TABLE_TIMEOUT_MS, signal);
  const gpus = table === null ? [] : electronHelperProcesses(mainPid, table)
    .filter((helper) => helper.role === "gpu-process" && helper.ppid === mainPid);
  if (gpus.length !== 1) return null;
  const gpu = gpus[0]!;
  const identity = await helperIdentity(gpu.pid, mainPid, signal);
  if (identity === null) return null;
  const stopped = gpu.stat.startsWith("T");
  const sample = stopped ? "" : await runTool("/usr/bin/sample",
    [String(gpu.pid), "1", "10", "-file", "/dev/stdout"], SAMPLE_TIMEOUT_MS, signal) ?? "";
  const stall = stopped ? "stopped" : gpuMainThreadStall(sample);
  if (stall === null || await helperIdentity(gpu.pid, mainPid, signal) !== identity || signal.aborted) return null;
  try {
    process.kill(gpu.pid, "SIGKILL");
  } catch {
    return null;
  }
  return { helper: `${gpu.pid} ${gpu.ppid} ${gpu.stat} ${gpu.role} stall=${stall}`, sample };
}

export async function probeVisibleWindows(electronApp: ElectronApplication): Promise<FrameProbe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unanswered = new Promise<"unanswered">((resolve) => {
    timer = setTimeout(() => resolve("unanswered"), FRAME_TIMEOUT_MS + MAIN_PROCESS_REPLY_MS);
  });
  try {
    const results = await Promise.race([unanswered, electronApp.evaluate(async ({ BrowserWindow }, probe) =>
      await Promise.all(BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed() && window.isVisible() && !window.isMinimized())
        .map(async (window) => await window.webContents
          .executeJavaScriptInIsolatedWorld(probe.worldId, [{ code: probe.source }])
          .catch(() => "unavailable") as string)),
    { worldId: PROBE_WORLD_ID, source: PROBE_SOURCE })]);
    if (results === "unanswered") return "stalled";
    if (results.includes("frames")) return "frames";
    return results.includes("stalled") ? "stalled" : "idle";
  } catch {
    return "idle";
  } finally {
    clearTimeout(timer);
  }
}

async function recordRecovery(recovery: GpuHelperRecovery): Promise<void> {
  const description = `No visible window produced two consecutive animation frames within ${FRAME_TIMEOUT_MS} ms on ${CONSECUTIVE_STALLED_PROBES} consecutive probes; `
    + `the fixture terminated only the stalled GPU helper (${recovery.helper}) so Chromium relaunches it.`;
  process.stderr.write(`[Inertia E2E] ${description}\n`);
  try {
    test.info().annotations.push({ type: GPU_HELPER_STALL_RECOVERED, description });
    if (recovery.sample) {
      await test.info().attach("gpu-helper-stall-sample", { body: recovery.sample, contentType: "text/plain" });
    }
  } catch {
    return;
  }
}

export function createFrameStallMonitor(dependencies: FrameStallMonitorDependencies): FrameStallMonitor {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recoveries = 0;
  let stalledProbes = 0;
  let evidenceBlockedUntil = 0;
  const schedule = (): void => {
    if (!controller.signal.aborted) timer = setTimeout(() => void tick(), MONITOR_INTERVAL_MS);
  };
  const tick = async (): Promise<void> => {
    try {
      const probe = await dependencies.probe();
      stalledProbes = probe === "stalled" ? stalledProbes + 1 : 0;
      if (stalledProbes < CONSECUTIVE_STALLED_PROBES || controller.signal.aborted) return;
      if (Date.now() < evidenceBlockedUntil || recoveries >= MAX_RECOVERIES_PER_APP) return;
      const recovery = await dependencies.recover(controller.signal);
      stalledProbes = 0;
      if (controller.signal.aborted) return;
      if (!recovery) {
        evidenceBlockedUntil = Date.now() + UNCONFIRMED_STALL_BACKOFF_MS;
        return;
      }
      recoveries += 1;
      await dependencies.record(recovery);
    } catch {
      return;
    } finally {
      schedule();
    }
  };
  schedule();
  return {
    stop: () => {
      controller.abort();
      clearTimeout(timer);
    },
  };
}

export function startFrameStallMonitor(electronApp: ElectronApplication): FrameStallMonitor {
  if (process.platform !== "darwin") return { stop: () => undefined };
  const monitor = createFrameStallMonitor({
    probe: async () => await probeVisibleWindows(electronApp),
    recover: async (signal) => {
      const mainPid = electronApp.process().pid;
      return mainPid ? await terminateStalledGpuHelper(mainPid, signal) : null;
    },
    record: recordRecovery,
  });
  const stop = (): void => {
    monitor.stop();
    electronApp.off("close", stop);
  };
  electronApp.once("close", stop);
  return { stop };
}
