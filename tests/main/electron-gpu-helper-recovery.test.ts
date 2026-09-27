import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createElectronMainProcessDiagnostic, type ElectronMainProcessDiagnostic } from
  "../e2e/support/electron-main-process-diagnostic";
import { closeElectronFixtureBounded, ElectronFixtureCloseError, GPU_HELPER_RECOVERY_GRACE_MS,
  quitElectronAppBounded } from "../e2e/support/electron-app-lifecycle";
import { attachElectronGpuHelperRecovery } from "../e2e/support/electron-failure-evidence";

const MAIN_PID = 123456;
const GPU_PID = 777;
const STARTED = `${MAIN_PID} Sat Sep 26 20:00:00 2026`;
const TABLE = [
  `${MAIN_PID} 900 S /tmp/Electron .`,
  `${GPU_PID} ${MAIN_PID} T /tmp/Electron Helper (GPU) --type=gpu-process --token=secret`,
  `778 ${MAIN_PID} S /tmp/Electron Helper (Renderer) --type=renderer`,
  "779 778 S /tmp/Electron Helper (GPU) --type=gpu-process",
].join("\n");

function child(pid: number): ChildProcess {
  const instance = Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(),
    kill: vi.fn((signal: NodeJS.Signals) => {
      instance.signalCode = signal;
      instance.emit("exit", null, signal);
      return true;
    }),
  });
  return instance as unknown as ChildProcess;
}

function exit(process: ChildProcess, code = 0): void {
  Object.assign(process, { exitCode: code });
  process.emit("exit", code, null);
}

function fixture(platform: NodeJS.Platform = "darwin") {
  const main = child(MAIN_PID);
  const tools: ChildProcess[] = [];
  const spawnTool = vi.fn(() => {
    const tool = child(900_000 + tools.length);
    tools.push(tool);
    return tool;
  });
  const signalProcess = vi.fn();
  const diagnostic = createElectronMainProcessDiagnostic(main, {
    platform, spawn: spawnTool as unknown as typeof spawn, killGroup: vi.fn(), signalProcess,
  });
  const reply = (index: number, output: string, code = 0): void => {
    const tool = tools[index]!;
    tool.stdout!.emit("data", Buffer.from(output));
    tool.emit("close", code, null);
  };
  const commands = (): string[] => spawnTool.mock.calls
    .map((call) => (call as unknown[]).slice(0, 2).flat().join(" "));
  return { main, tools, spawnTool, signalProcess, diagnostic, reply, commands };
}

const table = "/bin/ps -axww -o pid=,ppid=,stat=,command=";
const identity = `/bin/ps -o ppid=,lstart= -p ${GPU_PID}`;

afterEach(() => vi.useRealTimers());

describe("stalled window-destroy GPU helper recovery", () => {
  it("signals only the direct GPU helper after its identity holds across a fresh role check", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const recovery = f.diagnostic.terminateStalledGpuHelper(Date.now() + 10_000, () => true);
    f.reply(0, TABLE);
    f.reply(1, `  ${STARTED}\n`);
    f.reply(2, TABLE);
    expect(f.signalProcess).not.toHaveBeenCalled();
    f.reply(3, `${STARTED}\n`);
    await expect(recovery).resolves.toBe(true);
    expect(f.commands()).toEqual([table, identity, table, identity]);
    expect(f.signalProcess).toHaveBeenCalledExactlyOnceWith(GPU_PID, "SIGKILL");
    expect(f.main.kill).not.toHaveBeenCalled();
    expect(f.diagnostic.samples).toEqual([{
      pid: MAIN_PID, reason: "gpu-helper-recovery", status: "terminated",
      output: `${GPU_PID} ${MAIN_PID} T gpu-process`, truncated: false,
    }]);
    expect(JSON.stringify(f.diagnostic.samples)).not.toContain("secret");
    f.diagnostic.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["a reused PID", [TABLE, STARTED, TABLE, `${MAIN_PID} Sat Sep 26 20:00:07 2026`], "discarded-helper-identity-changed"],
    ["a reparented PID", [TABLE, "1 Sat Sep 26 20:00:00 2026"], "helper-identity-unavailable"],
    ["an exited helper", [TABLE, STARTED, TABLE, ""], "discarded-helper-identity-changed"],
    ["a different confirmed helper", [TABLE, STARTED, TABLE.replace(`${GPU_PID} ${MAIN_PID}`, `888 ${MAIN_PID}`)],
      "discarded-helper-identity-changed"],
    ["a helper that left the table", [TABLE, STARTED, `${MAIN_PID} 900 S /tmp/Electron .`], "no-gpu-helper"],
    ["only a nested GPU process", ["779 778 S x --type=gpu-process\n778 123456 S x --type=renderer"], "no-gpu-helper"],
    ["two direct GPU helpers", [`${TABLE}\n780 ${MAIN_PID} S x --type=gpu-process`], "ambiguous-gpu-helper"],
    ["an unavailable process table", [""], "helper-table-failed: exit=1, signal=null"],
  ])("never signals %s", async (_label, outputs, status) => {
    vi.useFakeTimers();
    const f = fixture();
    const recovery = f.diagnostic.terminateStalledGpuHelper(Date.now() + 10_000, () => true);
    outputs.forEach((output, index) => f.reply(index, output, output ? 0 : 1));
    await expect(recovery).resolves.toBe(false);
    expect(f.spawnTool).toHaveBeenCalledTimes(outputs.length);
    expect(f.signalProcess).not.toHaveBeenCalled();
    expect(f.diagnostic.samples[0]!.status).toBe(status);
    f.diagnostic.stop();
  });

  it("does not signal once window destroy returned or the main process exited", async () => {
    vi.useFakeTimers();
    const returned = fixture();
    const first = returned.diagnostic.terminateStalledGpuHelper(Date.now() + 10_000, () => false);
    [TABLE, STARTED, TABLE, STARTED].forEach((output, index) => returned.reply(index, output));
    await expect(first).resolves.toBe(false);
    expect(returned.diagnostic.samples[0]!.status).toBe("window-destroy-returned");
    const exited = fixture();
    const second = exited.diagnostic.terminateStalledGpuHelper(Date.now() + 10_000, () => true);
    exited.reply(0, TABLE);
    exited.reply(1, STARTED);
    exit(exited.main);
    await expect(second).resolves.toBe(false);
    expect(exited.spawnTool).toHaveBeenCalledTimes(3);
    expect(exited.diagnostic.samples[0]!.status)
      .toBe("helper-table-cancelled-at-fixture-exit-or-kill-deadline");
    for (const f of [returned, exited]) expect(f.signalProcess).not.toHaveBeenCalled();
    returned.diagnostic.stop();
  });

  it("records a failed signal without throwing", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.signalProcess.mockImplementation(() => { throw new Error("EPERM"); });
    const recovery = f.diagnostic.terminateStalledGpuHelper(Date.now() + 10_000, () => true);
    [TABLE, STARTED, TABLE, STARTED].forEach((output, index) => f.reply(index, output));
    await expect(recovery).resolves.toBe(false);
    expect(f.diagnostic.samples[0]!.status).toBe("signal-failed: Error: EPERM");
    f.diagnostic.stop();
  });

  it.each(["linux", "win32"] as const)("never probes or signals on %s", async (platform) => {
    const f = fixture(platform);
    await expect(f.diagnostic.terminateStalledGpuHelper(Date.now() + 10_000, () => true)).resolves.toBe(false);
    expect(f.spawnTool).not.toHaveBeenCalled();
    expect(f.signalProcess).not.toHaveBeenCalled();
    expect(f.diagnostic.samples).toEqual([]);
  });

  it("keeps a two-second exit reserve before the kill deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await expect(f.diagnostic.terminateStalledGpuHelper(Date.now() + 2_250, () => true)).resolves.toBe(false);
    expect(f.spawnTool).not.toHaveBeenCalled();
    expect(f.diagnostic.samples[0]!.status).toBe("helper-table-skipped-insufficient-existing-budget");
  });

  it("lets an in-flight GPU helper sample finish before signalling", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.diagnostic.watchQuit(Date.now() + 12_000);
    await vi.advanceTimersByTimeAsync(1_000);
    f.reply(1, TABLE);
    f.reply(2, STARTED);
    expect(f.diagnostic.samples[2]).toMatchObject({ reason: "gpu-helper-still-pending", status: "sampling" });
    const recovery = f.diagnostic.terminateStalledGpuHelper(Date.now() + 11_000, () => true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.spawnTool).toHaveBeenCalledTimes(4);
    f.reply(3, "gpu helper stack");
    f.reply(4, STARTED);
    expect(f.diagnostic.samples[2]).toMatchObject({ status: "completed", output: "gpu helper stack" });
    [TABLE, STARTED, TABLE, STARTED].forEach((output, index) => f.reply(5 + index, output));
    await expect(recovery).resolves.toBe(true);
    expect(f.signalProcess).toHaveBeenCalledExactlyOnceWith(GPU_PID, "SIGKILL");
    f.diagnostic.stop();
  });

  it("stops waiting for a stuck helper sample four seconds before the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.diagnostic.watchQuit(Date.now() + 12_000);
    await vi.advanceTimersByTimeAsync(1_000);
    f.reply(1, TABLE);
    f.reply(2, STARTED);
    const recovery = f.diagnostic.terminateStalledGpuHelper(Date.now() + 9_000, () => true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.spawnTool).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.commands()[4]).toBe(table);
    [TABLE, STARTED, TABLE, STARTED].forEach((output, index) => f.reply(4 + index, output));
    await expect(recovery).resolves.toBe(true);
    f.diagnostic.stop();
  });
});

function stubDiagnostic(terminate: ElectronMainProcessDiagnostic["terminateStalledGpuHelper"]) {
  return {
    capture: vi.fn(), watchQuit: vi.fn(() => () => undefined), stop: vi.fn(),
    samples: [{ pid: MAIN_PID, reason: "gpu-helper-recovery", status: "terminated",
      output: `${GPU_PID} ${MAIN_PID} T gpu-process`, truncated: false }],
    terminateStalledGpuHelper: vi.fn(terminate),
  } satisfies ElectronMainProcessDiagnostic;
}

function closeWith(options: {
  main: ChildProcess;
  diagnostic: ElectronMainProcessDiagnostic;
  platform?: NodeJS.Platform;
  cleanupConfirmed?: boolean;
  stderr?: string[];
}) {
  return closeElectronFixtureBounded({
    platform: options.platform ?? "darwin",
    current: { process: () => options.main, close: async () => undefined } as unknown as ElectronApplication,
    prepareRuntimeQuit: async () => ({
      phase: "privileged-cleanup-complete", runtimePid: null,
      cleanupConfirmed: options.cleanupConfirmed ?? true, errorMessage: null,
    }),
    requestRuntimeQuit: async () => {
      for (const stage of options.stderr ?? ["window-destroy-entered"]) {
        options.main.stderr!.emit("data", Buffer.from(`[Inertia test exit: ${stage}]\n`));
      }
      return null;
    },
    waitForRuntimeExit: vi.fn(async () => undefined),
    closeServer: vi.fn(async () => undefined),
    removeDirectory: vi.fn(async () => undefined),
    rpcTimeoutMs: 5_000, preparedExitTimeoutMs: 12_000,
    createMainProcessDiagnostic: () => options.diagnostic,
  });
}

describe("prepared close with a stalled window destroy", () => {
  it("passes with recorded recovery when the app exits cleanly after the GPU helper is terminated", async () => {
    vi.useFakeTimers();
    const main = child(MAIN_PID);
    let stillStalled: (() => boolean) | undefined;
    const diagnostic = stubDiagnostic(async (_deadlineAt, stalled) => {
      stillStalled = stalled;
      expect(stalled()).toBe(true);
      setTimeout(() => {
        main.stderr!.emit("data", Buffer.from("[Inertia test exit: window-destroy-returned]\n"));
        exit(main);
      }, 50);
      return true;
    });
    const closing = closeWith({ main, diagnostic });
    await vi.advanceTimersByTimeAsync(GPU_HELPER_RECOVERY_GRACE_MS - 1);
    expect(diagnostic.terminateStalledGpuHelper).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostic.terminateStalledGpuHelper).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    const recovery = await closing;
    expect(stillStalled!()).toBe(false);
    expect(main.kill).not.toHaveBeenCalled();
    expect(recovery!.mainProcessSamples).toBe(diagnostic.samples);
    const stages = recovery!.processEvidence!.stages.map((entry) => entry.stage);
    expect(stages.slice(0, 7)).toEqual(["cleanup-prepared", "quit-requested", "window-destroy-entered",
      "quit-request-fulfilled", "gpu-helper-terminated", "window-destroy-returned", "launcher-exit"]);
    expect(stages).toContain("graceful-exit");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns no recovery for a healthy close", async () => {
    vi.useFakeTimers();
    const main = child(MAIN_PID);
    const diagnostic = stubDiagnostic(async () => true);
    const closing = closeWith({ main, diagnostic, stderr: ["window-destroy-entered", "window-destroy-returned"] });
    await vi.advanceTimersByTimeAsync(10);
    exit(main);
    await expect(closing).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(GPU_HELPER_RECOVERY_GRACE_MS);
    expect(diagnostic.terminateStalledGpuHelper).not.toHaveBeenCalled();
  });

  it.each([
    ["after window destroy returned", { stderr: ["window-destroy-entered", "window-destroy-returned"] }],
    ["before window destroy was entered", { stderr: ["app-quit-entered"] }],
    ["on Linux", { platform: "linux" as const }],
  ])("still force-terminates and fails a main-process hang %s", async (_label, variant) => {
    vi.useFakeTimers();
    const main = child(MAIN_PID);
    const diagnostic = stubDiagnostic(async () => true);
    const closing = closeWith({ main, diagnostic, ...variant }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    const error = await closing;
    expect(diagnostic.terminateStalledGpuHelper).not.toHaveBeenCalled();
    expect(main.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(error).toBeInstanceOf(ElectronFixtureCloseError);
    expect((error as ElectronFixtureCloseError).errors.map((entry) => (entry as Error).message)).toContain(
      "The Electron fixture process required forced termination during close (phase=privileged-cleanup-complete).");
  });

  it("never attempts recovery when privileged cleanup was not confirmed", async () => {
    vi.useFakeTimers();
    const main = child(MAIN_PID);
    const diagnostic = stubDiagnostic(async () => true);
    const closing = closeWith({ main, diagnostic, cleanupConfirmed: false }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await closing).toBeInstanceOf(ElectronFixtureCloseError);
    expect(diagnostic.terminateStalledGpuHelper).not.toHaveBeenCalled();
  });

  it("still fails and keeps the recovery stage when the app hangs after the GPU helper is terminated", async () => {
    vi.useFakeTimers();
    const main = child(MAIN_PID);
    const diagnostic = stubDiagnostic(async () => true);
    const closing = closeWith({ main, diagnostic }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    const error = await closing as ElectronFixtureCloseError;
    expect(diagnostic.terminateStalledGpuHelper).toHaveBeenCalledOnce();
    expect(main.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(error.processEvidence!.stages.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(["window-destroy-entered", "gpu-helper-terminated", "force-stop-started"]));
    expect(error.mainProcessSamples).toBe(diagnostic.samples);
  });

  it("never attempts recovery from the restart quit path", async () => {
    vi.useFakeTimers();
    const main = child(MAIN_PID);
    const diagnostic = stubDiagnostic(async () => true);
    const quitting = quitElectronAppBounded(
      { process: () => main, close: async () => undefined } as unknown as ElectronApplication,
      async () => {
        main.stderr!.emit("data", Buffer.from("[Inertia test exit: window-destroy-entered]\n"));
        return null;
      },
      { platform: "darwin", childProcess: main, mainProcessDiagnostic: diagnostic, gracefulTimeoutMs: 12_000 },
    );
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await quitting).outcome).toBe("forced");
    expect(diagnostic.terminateStalledGpuHelper).not.toHaveBeenCalled();
  });

  it("annotates the test and attaches the stage history and helper evidence", async () => {
    const attach = vi.fn(async () => undefined);
    const annotations: { type: string; description?: string }[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const recovery = {
      processEvidence: { launcherPid: MAIN_PID, mainPid: MAIN_PID, mainIdentity: "captured" as const,
        launcherExitObserved: true, launcherCloseObserved: true, launcherExitCode: 0,
        stages: [{ stage: "gpu-helper-terminated" as const, elapsedMs: 3_000 }] },
      mainProcessSamples: stubDiagnostic(async () => true).samples,
    };
    try {
      await attachElectronGpuHelperRecovery(() => ({ attach, annotations }), recovery);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("[Inertia E2E] Privileged cleanup completed"));
    } finally { write.mockRestore(); }
    expect(annotations).toEqual([{ type: "electron-gpu-helper-terminated",
      description: expect.stringContaining(`GPU helper (${GPU_PID} ${MAIN_PID} T gpu-process)`) }]);
    expect(attach).toHaveBeenCalledWith("electron-process-lifecycle", {
      contentType: "application/json", body: Buffer.from(JSON.stringify(recovery.processEvidence, null, 2)),
    });
    expect(attach).toHaveBeenCalledWith("electron-main-process-samples", {
      contentType: "application/json", body: Buffer.from(JSON.stringify(recovery.mainProcessSamples, null, 2)),
    });
  });
});
