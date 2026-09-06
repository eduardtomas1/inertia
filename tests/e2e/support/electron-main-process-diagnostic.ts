import { spawn, type ChildProcess } from "node:child_process";

const SAMPLE_TIMEOUT_MS = 2_000;
const SAMPLE_HEADROOM_MS = 250;
const QUIT_WATCHDOG_MS = 1_000;
const MAX_SAMPLE_BYTES = 128 * 1024;

export interface ElectronMainProcessSample {
  readonly pid: number;
  readonly reason: string;
  status: string;
  output: string;
  truncated: boolean;
}

export interface ElectronMainProcessDiagnostic {
  capture: (reason: string, deadlineAt: number) => void;
  watchQuit: (deadlineAt: number) => () => void;
  stop: () => void;
  samples: ElectronMainProcessSample[];
}

export function createElectronMainProcessDiagnostic(
  main: ChildProcess,
  dependencies: {
    platform?: NodeJS.Platform;
    spawn?: typeof spawn;
    killGroup?: (pid: number) => void;
  } = {},
): ElectronMainProcessDiagnostic {
  const platform = dependencies.platform ?? process.platform;
  const spawnSample = dependencies.spawn ?? spawn;
  const killGroup = dependencies.killGroup ?? ((pid: number) => {
    process.kill(-pid, "SIGKILL");
  });
  const pid = main.pid;
  const samples: ElectronMainProcessSample[] = [];
  let stopped = false;
  let cancelSample: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const ownsLiveMain = (): boolean => !stopped
    && Number.isSafeInteger(pid) && pid! > 0 && pid !== process.pid
    && main.pid === pid && main.exitCode === null && main.signalCode === null;
  const clearWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  const stop = (): void => {
    stopped = true;
    clearWatchdog();
    cancelSample?.();
    main.off("exit", stop);
  };
  const capture = (reason: string, deadlineAt: number): void => {
    if (platform !== "darwin" || !ownsLiveMain() || cancelSample
      || samples.length >= 2) return;
    const record: ElectronMainProcessSample = {
      pid: pid!, reason, status: "starting", output: "", truncated: false,
    };
    samples.push(record);
    if (deadlineAt - Date.now() < SAMPLE_TIMEOUT_MS + SAMPLE_HEADROOM_MS) {
      record.status = "skipped-insufficient-existing-budget";
      return;
    }
    let sample: ChildProcess;
    try {
      sample = spawnSample("/usr/bin/sample", [
        String(pid), "1", "10", "-file", "/dev/stdout",
      ], {
        shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
    } catch (error) {
      record.status = `unavailable: ${String(error).slice(0, 512)}`;
      return;
    }
    record.status = "sampling";
    let bytes = 0;
    let finished = false;
    const chunks: Buffer[] = [];
    const drain = (chunk: Buffer): void => {
      const remaining = MAX_SAMPLE_BYTES - bytes;
      if (chunk.length > remaining) record.truncated = true;
      if (remaining > 0) {
        const retained = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(retained);
        bytes += retained.length;
      }
    };
    const finish = (status: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      record.status = status;
      // The detached sampler owns its own process group, including any
      // symbolication children. Never signal the fixture's process group.
      if (sample.pid) {
        try { killGroup(sample.pid); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            record.status += `; sampler-stop-failed: ${String(error).slice(0, 512)}`;
          }
        }
      }
      record.output = Buffer.concat(chunks).toString("utf8");
      sample.stdout?.destroy();
      sample.stderr?.destroy();
      sample.unref();
      cancelSample = null;
    };
    const timer = setTimeout(() => finish("timed-out"), SAMPLE_TIMEOUT_MS);
    timer.unref();
    cancelSample = () => finish("cancelled-at-fixture-exit-or-kill-deadline");
    sample.stdout?.on("data", drain);
    sample.stderr?.on("data", drain);
    sample.once("error", (error) => finish(
      `unavailable: ${error.message.slice(0, 512)}`,
    ));
    sample.once("close", (code, signal) => finish(
      code === 0 ? "completed" : `failed: exit=${String(code)}, signal=${String(signal)}`,
    ));
    // A retained ChildProcess exit permanently revokes PID authority; never
    // discover a replacement process or retry after it exits.
    if (!ownsLiveMain()) cancelSample?.();
  };
  if (platform === "darwin") main.once("exit", stop);
  return {
    capture, samples, stop,
    watchQuit: (deadlineAt) => {
      clearWatchdog();
      if (platform === "darwin" && ownsLiveMain()
        && deadlineAt - Date.now()
          >= QUIT_WATCHDOG_MS + SAMPLE_TIMEOUT_MS + SAMPLE_HEADROOM_MS) {
        watchdog = setTimeout(() => {
          watchdog = null;
          capture("prepared-quit-still-pending", deadlineAt);
        }, QUIT_WATCHDOG_MS);
        watchdog.unref();
      }
      return clearWatchdog;
    },
  };
}
