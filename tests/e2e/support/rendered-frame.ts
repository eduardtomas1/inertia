import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { test, type ElectronApplication, type Page } from "@playwright/test";

import { electronHelperProcesses, gpuMainThreadStall } from "./electron-main-process-diagnostic";

const execFileAsync = promisify(execFile);
const FRAME_TIMEOUT_MS = 1_000;
const PROCESS_TABLE_TIMEOUT_MS = 1_000;
const SAMPLE_TIMEOUT_MS = 6_000;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;

export const GPU_HELPER_STALL_RECOVERED = "electron-gpu-helper-stall-recovered";

interface GpuHelperRecovery {
  helper: string;
  sample: string;
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

async function runTool(command: string, args: string[], timeout: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeout,
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function helperIdentity(pid: number, mainPid: number): Promise<string | null> {
  const identity = (await runTool("/bin/ps", ["-o", "ppid=,lstart=", "-p", String(pid)],
    PROCESS_TABLE_TIMEOUT_MS))?.trim() ?? "";
  return identity.split(/\s+/u)[0] === String(mainPid) ? identity : null;
}

async function terminateStalledGpuHelper(mainPid: number): Promise<GpuHelperRecovery | null> {
  const table = await runTool("/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,command="],
    PROCESS_TABLE_TIMEOUT_MS);
  const gpus = table === null ? [] : electronHelperProcesses(mainPid, table)
    .filter((helper) => helper.role === "gpu-process" && helper.ppid === mainPid);
  if (gpus.length !== 1) return null;
  const gpu = gpus[0]!;
  const identity = await helperIdentity(gpu.pid, mainPid);
  if (identity === null) return null;
  const stopped = gpu.stat.startsWith("T");
  const sample = stopped ? "" : await runTool("/usr/bin/sample",
    [String(gpu.pid), "1", "10", "-file", "/dev/stdout"], SAMPLE_TIMEOUT_MS) ?? "";
  const stall = stopped ? "stopped" : gpuMainThreadStall(sample);
  if (stall === null || await helperIdentity(gpu.pid, mainPid) !== identity) return null;
  try {
    process.kill(gpu.pid, "SIGKILL");
  } catch {
    return null;
  }
  return { helper: `${gpu.pid} ${gpu.ppid} ${gpu.stat} ${gpu.role} stall=${stall}`, sample };
}

async function recordRecovery(recovery: GpuHelperRecovery): Promise<void> {
  const description = `The renderer did not produce two consecutive animation frames within ${FRAME_TIMEOUT_MS} ms after an action checkpoint; `
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

async function recoverRenderedFrames(page: Page, electronApp: ElectronApplication): Promise<void> {
  if (await renderedFrame(page)) return;
  const mainPid = electronApp.process().pid;
  const recovery = mainPid ? await terminateStalledGpuHelper(mainPid) : null;
  if (recovery) await recordRecovery(recovery);
}

export async function guardRenderedFrames(page: Page, electronApp: ElectronApplication): Promise<void> {
  if (process.platform !== "darwin") return;
  let monitor: Promise<void> | null = null;
  await page.addLocatorHandler(page.locator(":root"), async () => {
    monitor ??= recoverRenderedFrames(page, electronApp)
      .catch(() => undefined)
      .finally(() => { monitor = null; });
  }, { noWaitAfter: true });
}
