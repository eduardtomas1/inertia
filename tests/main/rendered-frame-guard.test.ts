import type { ElectronApplication } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

import {
  createFrameStallMonitor, probeVisibleWindows, startFrameStallMonitor,
  type FrameProbe, type GpuHelperRecovery,
} from "../e2e/support/rendered-frame";

const MAIN_PID = 4242;
const GPU_PID = 777;
const STARTED = `${MAIN_PID} Tue Sep 29 10:00:00 2026`;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

interface FakeWindow {
  visible: boolean;
  minimized?: boolean;
  frames: () => Promise<string>;
}

function fakeElectronApp(windows: FakeWindow[]) {
  const listeners = new Map<string, () => void>();
  const app = {
    process: () => ({ pid: MAIN_PID }),
    once: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener); }),
    off: vi.fn((event: string) => { listeners.delete(event); }),
    evaluate: vi.fn(async (callback: (electron: unknown, argument: unknown) => unknown, argument: unknown) =>
      await callback({
        BrowserWindow: {
          getAllWindows: () => windows.map((window) => ({
            isDestroyed: () => false,
            isVisible: () => window.visible,
            isMinimized: () => window.minimized ?? false,
            webContents: { executeJavaScriptInIsolatedWorld: async () => await window.frames() },
          })),
        },
      }, argument)),
  };
  return { app, listeners, electronApp: app as unknown as ElectronApplication };
}

function replyToProcessTools(gpuState: () => string): void {
  execFile.mockImplementation((command: string, args: string[], _options: unknown,
    callback: (error: Error | null, result: { stdout: string }) => void) => {
    if (command === "/bin/ps" && args[0] === "-axww") {
      callback(null, { stdout: `${MAIN_PID} 1 S /tmp/Electron .\n${GPU_PID} ${MAIN_PID} ${gpuState()} /tmp/Electron Helper (GPU) --type=gpu-process\n` });
    } else if (command === "/bin/ps") {
      callback(null, { stdout: `${STARTED}\n` });
    } else {
      callback(null, { stdout: "" });
    }
  });
}

const stalledFrames = () => new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 1_000));
const healthyFrames = () => new Promise<string>((resolve) => setTimeout(() => resolve("frames"), 16));

describe("frame-stall monitor", () => {
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    execFile.mockReset();
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", platform);
    vi.useRealTimers();
  });

  it("recovers a stall while only a secondary window is visible and receives actions", async () => {
    let gpu = "S";
    replyToProcessTools(() => gpu);
    const fake = fakeElectronApp([
      { visible: false, frames: healthyFrames },
      { visible: true, frames: () => gpu === "T" ? stalledFrames() : healthyFrames() },
    ]);
    const monitor = startFrameStallMonitor(fake.electronApp);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).not.toHaveBeenCalled();
    gpu = "T";
    await vi.advanceTimersByTimeAsync(8_000);
    expect(kill).toHaveBeenCalledExactlyOnceWith(GPU_PID, "SIGKILL");
    monitor.stop();
  });

  it("keeps watching after healthy probes and recovers a stall that begins mid-action", async () => {
    let gpu = "S";
    replyToProcessTools(() => gpu);
    const fake = fakeElectronApp([{ visible: true, frames: () => gpu === "T" ? stalledFrames() : healthyFrames() }]);
    const monitor = startFrameStallMonitor(fake.electronApp);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.app.evaluate.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(kill).not.toHaveBeenCalled();
    gpu = "T";
    await vi.advanceTimersByTimeAsync(8_000);
    expect(kill).toHaveBeenCalledExactlyOnceWith(GPU_PID, "SIGKILL");
    monitor.stop();
  });

  it("classifies hidden, minimized and absent windows as idle and never samples for them", async () => {
    replyToProcessTools(() => "T");
    const hidden = fakeElectronApp([
      { visible: false, frames: stalledFrames },
      { visible: true, minimized: true, frames: stalledFrames },
    ]);
    const probe = probeVisibleWindows(hidden.electronApp);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(probe).resolves.toBe("idle");
    const monitor = startFrameStallMonitor(hidden.electronApp);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(execFile).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("reports frames when any visible window renders and a stall only when none does", async () => {
    const results = async (windows: FakeWindow[]): Promise<FrameProbe> => {
      const probe = probeVisibleWindows(fakeElectronApp(windows).electronApp);
      await vi.advanceTimersByTimeAsync(5_000);
      return await probe;
    };
    await expect(results([{ visible: true, frames: stalledFrames }, { visible: true, frames: healthyFrames }]))
      .resolves.toBe("frames");
    await expect(results([{ visible: true, frames: stalledFrames }])).resolves.toBe("stalled");
    await expect(results([{ visible: true, frames: async () => "hidden" }])).resolves.toBe("idle");
    await expect(results([{ visible: true, frames: () => new Promise<string>(() => undefined) }]))
      .resolves.toBe("stalled");
  });

  it("never samples or kills after a single probe without frames when the next probe renders", async () => {
    const verdicts: FrameProbe[] = ["stalled", "frames", "stalled", "frames", "stalled", "idle", "stalled", "frames"];
    const probe = vi.fn(async (): Promise<FrameProbe> => verdicts.shift() ?? "frames");
    const recover = vi.fn(async (): Promise<GpuHelperRecovery> => ({ helper: "gpu", sample: "" }));
    const monitor = createFrameStallMonitor({ probe, recover, record: vi.fn(async () => undefined) });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(recover).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("does not kill a stopped helper when the only visible window is hidden right after a probe listed it", async () => {
    replyToProcessTools(() => "T");
    const workbench: FakeWindow = { visible: true, frames: stalledFrames };
    const fake = fakeElectronApp([workbench]);
    const monitor = startFrameStallMonitor(fake.electronApp);
    await vi.advanceTimersByTimeAsync(2_000);
    workbench.visible = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(kill).not.toHaveBeenCalled();
    workbench.visible = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(kill).toHaveBeenCalledExactlyOnceWith(GPU_PID, "SIGKILL");
    monitor.stop();
  });

  it("treats a closing app whose evaluate rejects as idle", async () => {
    const fake = fakeElectronApp([]);
    fake.app.evaluate.mockRejectedValueOnce(new Error("Target closed"));
    await expect(probeVisibleWindows(fake.electronApp)).resolves.toBe("idle");
  });

  it("recovers a second stall after the relaunched helper stalls, then stops at two recoveries", async () => {
    const probe = vi.fn(async (): Promise<FrameProbe> => "stalled");
    const recover = vi.fn(async (): Promise<GpuHelperRecovery> => ({ helper: "gpu", sample: "" }));
    const record = vi.fn(async () => undefined);
    const monitor = createFrameStallMonitor({ probe, recover, record });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(recover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("backs off evidence sampling for 30 s after a stall that the evidence does not confirm", async () => {
    const probe = vi.fn(async (): Promise<FrameProbe> => "stalled");
    const recover = vi.fn(async (): Promise<GpuHelperRecovery | null> => null);
    const monitor = createFrameStallMonitor({ probe, recover, record: vi.fn(async () => undefined) });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(recover).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("aborts an in-flight recovery when the fixture starts closing and leaves no timers behind", async () => {
    let signal: AbortSignal | undefined;
    const probe = vi.fn(async (): Promise<FrameProbe> => "stalled");
    const recover = vi.fn(async (aborted: AbortSignal) => {
      signal = aborted;
      return await new Promise<GpuHelperRecovery>((resolve) => setTimeout(() => resolve({ helper: "gpu", sample: "" }), 3_000));
    });
    const record = vi.fn(async () => undefined);
    const monitor = createFrameStallMonitor({ probe, recover, record });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(recover).toHaveBeenCalledOnce();
    monitor.stop();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(record).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops with the Electron app and removes its close listener", async () => {
    const fake = fakeElectronApp([{ visible: true, frames: healthyFrames }]);
    const monitor = startFrameStallMonitor(fake.electronApp);
    expect(fake.listeners.has("close")).toBe(true);
    monitor.stop();
    expect(fake.listeners.has("close")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const closing = fakeElectronApp([{ visible: true, frames: healthyFrames }]);
    startFrameStallMonitor(closing.electronApp);
    closing.listeners.get("close")!();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no timers or listeners outside macOS", () => {
    for (const other of ["linux", "win32"]) {
      Object.defineProperty(process, "platform", { ...platform, value: other });
      const fake = fakeElectronApp([{ visible: true, frames: stalledFrames }]);
      startFrameStallMonitor(fake.electronApp);
      expect(fake.app.once).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
