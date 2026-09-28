import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { electronHelperProcesses, gpuMainThreadStall } from "./electron-main-process-diagnostic";

const execFileAsync = promisify(execFile);
const FRAME_TIMEOUT_MS = 1_000;
const PROCESS_TABLE_TIMEOUT_MS = 1_000;
const SAMPLE_TIMEOUT_MS = 6_000;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;

interface GpuHelperRecovery {
  helper: string;
  sample: string;
}

export async function renderedFrame(page: Page): Promise<boolean> {
  return await page.evaluate((timeout) => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve(true);
    });
  }), FRAME_TIMEOUT_MS);
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

export async function waitForRenderedFrame(
  app: { readonly page: Page; readonly electronApp: ElectronApplication },
): Promise<void> {
  if (await renderedFrame(app.page) || process.platform !== "darwin") return;
  const mainPid = app.electronApp.process().pid;
  const recovery = mainPid ? await terminateStalledGpuHelper(mainPid) : null;
  if (!recovery) return;
  const description = `The renderer produced no animation frame within ${FRAME_TIMEOUT_MS} ms; `
    + `the fixture terminated only the stalled GPU helper (${recovery.helper}) so Chromium relaunches it.`;
  process.stderr.write(`[Inertia E2E] ${description}\n`);
  test.info().annotations.push({ type: "electron-gpu-helper-stall-recovered", description });
  if (recovery.sample) {
    await test.info().attach("gpu-helper-stall-sample", { body: recovery.sample, contentType: "text/plain" });
  }
  await expect.poll(() => renderedFrame(app.page)).toBe(true);
}
