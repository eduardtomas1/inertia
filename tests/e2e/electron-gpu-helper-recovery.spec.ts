// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createAppFixture } from "./support/app-fixture";
import { electronHelperProcesses } from "./support/electron-main-process-diagnostic";

const execFileAsync = promisify(execFile);
const psOptions = { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 2_000 };

async function directGpuHelper(mainPid: number): Promise<number> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,command="],
    { ...psOptions, maxBuffer: 4 * 1024 * 1024 });
  const helpers = electronHelperProcesses(mainPid, stdout)
    .filter((helper) => helper.role === "gpu-process" && helper.ppid === mainPid);
  expect(helpers).toHaveLength(1);
  return helpers[0]!.pid;
}

async function processStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], psOptions);
    return stdout.trim() || null;
  } catch { return null; }
}

test.skip(process.platform !== "darwin", "Stalled GPU helper recovery applies only to macOS fixtures.");

test("finishes a prepared close by terminating only a stopped GPU helper while window destroy stalls", async () => {
  const app = await createAppFixture({ name: "gpu-helper-recovery", initialState: "empty" });
  const mainPid = app.electronApp.process().pid!;
  const gpuPid = await directGpuHelper(mainPid);
  const gpuStart = await processStart(gpuPid);
  expect(gpuStart).not.toBeNull();
  process.kill(gpuPid, "SIGSTOP");
  const closeStartedAt = Date.now();
  try {
    await app.close();
  } finally {
    if (await processStart(gpuPid) === gpuStart) process.kill(gpuPid, "SIGKILL");
  }
  expect(Date.now() - closeStartedAt).toBeLessThan(12_000);
  expect(await processStart(gpuPid)).toBeNull();
  const annotation = test.info().annotations.find((entry) => entry.type === "electron-gpu-helper-terminated");
  expect(annotation?.description).toContain(`${gpuPid} ${mainPid} T gpu-process`);
  const attachment = (name: string): unknown => JSON.parse(
    test.info().attachments.find((entry) => entry.name === name)!.body!.toString("utf8"));
  const lifecycle = attachment("electron-process-lifecycle") as { stages: { stage: string }[] };
  const stages = lifecycle.stages.map((entry) => entry.stage);
  const order = ["cleanup-prepared", "quit-requested", "window-destroy-entered",
    "gpu-helper-terminated", "window-destroy-returned"].map((stage) => stages.indexOf(stage));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((left, right) => left - right));
  expect(stages).toContain("graceful-exit");
  expect(stages).not.toContain("force-stop-started");
  const samples = attachment("electron-main-process-samples") as { reason: string; status: string; output: string }[];
  expect(samples.filter((sample) => sample.reason === "gpu-helper-recovery")).toEqual([
    expect.objectContaining({ status: "terminated", output: `${gpuPid} ${mainPid} T gpu-process` }),
  ]);
});
