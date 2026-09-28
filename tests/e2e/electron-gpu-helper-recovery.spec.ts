// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createAppFixture } from "./support/app-fixture";
import { GPU_HELPER_RECOVERY_GRACE_MS } from "./support/electron-app-lifecycle";
import { electronHelperProcesses } from "./support/electron-main-process-diagnostic";
import { electronProcessEvidence } from "./support/electron-process-evidence";
import { GPU_HELPER_STALL_RECOVERED, renderedFrame } from "./support/rendered-frame";
import { ensureWorkspaceTools, rightPanelToggle, selectWorkspaceTool } from "./support/workspace-tools";

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
  const evidence = electronProcessEvidence(app.electronApp.process());
  const gpuCompositing = await app.electronApp.evaluate(({ app: electronApp }) =>
    String((electronApp.getGPUFeatureStatus() as unknown as Record<string, unknown>).gpu_compositing));
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
  const annotation = test.info().annotations.find((entry) => entry.type === "electron-gpu-helper-terminated");
  if (!annotation) {
    const at = (stage: string): number | undefined =>
      evidence.snapshot().stages.find((entry) => entry.stage === stage)?.elapsedMs;
    const destroyMs = (at("window-destroy-returned") ?? Number.POSITIVE_INFINITY)
      - (at("window-destroy-entered") ?? 0);
    expect(destroyMs).toBeLessThan(GPU_HELPER_RECOVERY_GRACE_MS);
    expect(at("graceful-exit")).toBeDefined();
    test.skip(true, `BrowserWindow.destroy returned in ${destroyMs} ms without waiting on the stopped GPU `
      + `helper (gpu_compositing=${gpuCompositing}), so this host cannot reproduce the stall.`);
    return;
  }
  expect(await processStart(gpuPid)).toBeNull();
  const helperRow = new RegExp(`${gpuPid} ${mainPid} T\\S* gpu-process stall=stopped`, "u");
  expect(annotation.description).toMatch(helperRow);
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
    expect.objectContaining({ status: "terminated", output: expect.stringMatching(helperRow) }),
  ]);
});

function expectStallRecovered(gpuPid: number, mainPid: number): void {
  const recoveries = test.info().annotations.filter((entry) => entry.type === GPU_HELPER_STALL_RECOVERED);
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]!.description)
    .toMatch(new RegExp(`\\(${gpuPid} ${mainPid} T\\S* gpu-process stall=stopped\\)`, "u"));
}

test("recovers a GPU helper that stalls before the first action after launch", async () => {
  const app = await createAppFixture({ name: "gpu-helper-launch-frames", initialState: "conversation" });
  let gpuPid: number | undefined;
  let gpuStart: string | null = null;
  try {
    const mainPid = app.electronApp.process().pid!;
    gpuPid = await directGpuHelper(mainPid);
    gpuStart = await processStart(gpuPid);
    process.kill(gpuPid, "SIGSTOP");
    test.skip(await renderedFrame(app.page),
      "The renderer kept producing frames while the GPU helper was stopped, so this host cannot reproduce the stall.");
    const toggle = rightPanelToggle(app.page);
    const pressed = await toggle.getAttribute("aria-pressed");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", pressed === "true" ? "false" : "true");
    expectStallRecovered(gpuPid, mainPid);
    expect(await processStart(gpuPid)).toBeNull();
    expect(await directGpuHelper(mainPid)).not.toBe(gpuPid);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    if (gpuPid !== undefined && gpuStart !== null && await processStart(gpuPid) === gpuStart) {
      process.kill(gpuPid, "SIGKILL");
    }
    await app.close();
  }
});

test("recovers a GPU helper that stalls after restart before a workspace tool opens", async () => {
  const app = await createAppFixture({ name: "gpu-helper-restart-frames", initialState: "conversation" });
  let gpuPid: number | undefined;
  let gpuStart: string | null = null;
  try {
    const previousMainPid = app.electronApp.process().pid!;
    await app.restart();
    const mainPid = app.electronApp.process().pid!;
    expect(mainPid).not.toBe(previousMainPid);
    gpuPid = await directGpuHelper(mainPid);
    gpuStart = await processStart(gpuPid);
    process.kill(gpuPid, "SIGSTOP");
    test.skip(await renderedFrame(app.page),
      "The renderer kept producing frames while the GPU helper was stopped, so this host cannot reproduce the stall.");
    await selectWorkspaceTool(await ensureWorkspaceTools(app.page), "Attachments");
    await expect(app.page.locator('.workspace-panel [data-workspace-tab="attachments"]'))
      .toHaveAttribute("aria-selected", "true");
    expectStallRecovered(gpuPid, mainPid);
    expect(await processStart(gpuPid)).toBeNull();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    if (gpuPid !== undefined && gpuStart !== null && await processStart(gpuPid) === gpuStart) {
      process.kill(gpuPid, "SIGKILL");
    }
    await app.close();
  }
});
