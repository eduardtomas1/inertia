import { spawn, type ChildProcess } from "node:child_process";

const SAMPLE_TIMEOUT_MS = 6_000;
const MIN_SAMPLE_TIMEOUT_MS = 2_000;
const SAMPLE_HEADROOM_MS = 250;
const QUIT_WATCHDOG_MS = 1_000;
const MAX_SAMPLE_BYTES = 128 * 1024;
const PROCESS_TABLE_TIMEOUT_MS = 1_000;
const MAX_PROCESS_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_HELPER_IDENTITY_BYTES = 1024;
const MAX_HELPER_ROWS = 64;
const HELPER_ROLE = /(?:^|\s)--type=([a-z0-9_.-]{1,64})(?=\s|$)/u;
const UTILITY_ROLE = /(?:^|\s)--utility-sub-type=([a-zA-Z0-9_.-]{1,96})(?=\s|$)/u;

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

export interface ElectronHelperProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly stat: string;
  readonly role: string;
}

export function electronHelperProcesses(
  mainPid: number,
  processTable: string,
): ElectronHelperProcess[] {
  const rows = new Map<number, ElectronHelperProcess>();
  const children = new Map<number, number[]>();
  for (const line of processTable.split(/\r?\n/gu)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S{1,8})(?:\s+(.*))?$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const command = match[4] ?? "";
    const helper = HELPER_ROLE.exec(command)?.[1];
    const utility = UTILITY_ROLE.exec(command)?.[1];
    const role = helper ? (utility ? `${helper}/${utility}` : helper) : "other";
    rows.set(pid, { pid, ppid, stat: match[3]!, role });
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const helpers: ElectronHelperProcess[] = [];
  const visited = new Set<number>([mainPid]);
  const pending = [...(children.get(mainPid) ?? [])];
  while (pending.length > 0 && helpers.length < MAX_HELPER_ROWS) {
    const pid = pending.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    helpers.push(rows.get(pid)!);
    pending.push(...(children.get(pid) ?? []));
  }
  return helpers;
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
  const active = new Set<() => void>();
  let mainSamples = 0;
  let mainSampling = false;
  let helpersCaptured = false;
  let stopped = false;
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
    for (const cancel of active) cancel();
    main.off("exit", stop);
  };
  const run = (
    record: ElectronMainProcessSample,
    command: string,
    args: string[],
    timeoutMs: number,
    maxBytes: number,
    onFinish: (status: string, output: string) => void,
  ): void => {
    let tool: ChildProcess;
    try {
      tool = spawnSample(command, args, {
        shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
    } catch (error) {
      onFinish(`unavailable: ${String(error).slice(0, 512)}`, "");
      return;
    }
    record.status = "sampling";
    let bytes = 0;
    let finished = false;
    const chunks: Buffer[] = [];
    const drain = (chunk: Buffer): void => {
      const remaining = maxBytes - bytes;
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
      active.delete(cancel);
      let finalStatus = status;
      if (tool.pid) {
        try { killGroup(tool.pid); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            finalStatus += `; sampler-stop-failed: ${String(error).slice(0, 512)}`;
          }
        }
      }
      tool.stdout?.destroy();
      tool.stderr?.destroy();
      tool.unref();
      onFinish(finalStatus, Buffer.concat(chunks).toString("utf8"));
    };
    const cancel = (): void => finish("cancelled-at-fixture-exit-or-kill-deadline");
    const timer = setTimeout(() => finish("timed-out"), timeoutMs);
    timer.unref();
    active.add(cancel);
    tool.stdout?.on("data", drain);
    tool.stderr?.on("data", drain);
    tool.once("error", (error) => finish(
      `unavailable: ${error.message.slice(0, 512)}`,
    ));
    tool.once("close", (code, signal) => finish(
      code === 0 ? "completed" : `failed: exit=${String(code)}, signal=${String(signal)}`,
    ));
    if (!ownsLiveMain()) cancel();
  };
  const sampleBudget = (deadlineAt: number): number => Math.min(
    SAMPLE_TIMEOUT_MS,
    deadlineAt - Date.now() - SAMPLE_HEADROOM_MS,
  );
  const sampleProcess = (
    targetPid: number,
    reason: string,
    deadlineAt: number,
    onSettled: () => void,
  ): void => {
    const record: ElectronMainProcessSample = {
      pid: targetPid, reason, status: "starting", output: "", truncated: false,
    };
    samples.push(record);
    const timeoutMs = sampleBudget(deadlineAt);
    if (timeoutMs < MIN_SAMPLE_TIMEOUT_MS) {
      record.status = "skipped-insufficient-existing-budget";
      onSettled();
      return;
    }
    run(record, "/usr/bin/sample", [
      String(targetPid), "1", "10", "-file", "/dev/stdout",
    ], timeoutMs, MAX_SAMPLE_BYTES, (status, output) => {
      record.status = status;
      record.output = output;
      onSettled();
    });
  };
  const readHelperIdentity = (
    helperPid: number,
    deadlineAt: number,
    onIdentity: (identity: string | null) => void,
  ): void => {
    const timeoutMs = Math.min(
      PROCESS_TABLE_TIMEOUT_MS,
      deadlineAt - Date.now() - SAMPLE_HEADROOM_MS,
    );
    if (timeoutMs <= 0 || !ownsLiveMain()) {
      onIdentity(null);
      return;
    }
    const probe: ElectronMainProcessSample = {
      pid: helperPid, reason: "helper-identity", status: "starting", output: "", truncated: false,
    };
    run(probe, "/bin/ps", ["-o", "ppid=,lstart=", "-p", String(helperPid)], timeoutMs,
      MAX_HELPER_IDENTITY_BYTES, (status, output) => {
        const identity = output.trim();
        onIdentity(status === "completed" && identity.split(/\s+/u)[0] === String(pid)
          ? identity
          : null);
      });
  };
  const sampleHelper = (helperPid: number, deadlineAt: number): void => {
    readHelperIdentity(helperPid, deadlineAt, (before) => {
      if (before === null || !ownsLiveMain()) return;
      const record: ElectronMainProcessSample = {
        pid: helperPid, reason: "gpu-helper-still-pending", status: "starting",
        output: "", truncated: false,
      };
      samples.push(record);
      const timeoutMs = sampleBudget(deadlineAt);
      if (timeoutMs < MIN_SAMPLE_TIMEOUT_MS) {
        record.status = "skipped-insufficient-existing-budget";
        return;
      }
      run(record, "/usr/bin/sample", [
        String(helperPid), "1", "10", "-file", "/dev/stdout",
      ], timeoutMs, MAX_SAMPLE_BYTES, (status, output) => {
        record.status = "validating-helper-identity";
        readHelperIdentity(helperPid, deadlineAt, (after) => {
          if (after !== before) {
            record.status = "discarded-helper-identity-changed";
            return;
          }
          record.status = status;
          record.output = output;
        });
      });
    });
  };
  const capture = (reason: string, deadlineAt: number): void => {
    if (platform !== "darwin" || !ownsLiveMain() || mainSampling
      || mainSamples >= 2) return;
    mainSamples += 1;
    mainSampling = true;
    sampleProcess(pid!, reason, deadlineAt, () => { mainSampling = false; });
  };
  const captureHelpers = (deadlineAt: number): void => {
    if (helpersCaptured || !ownsLiveMain()) return;
    helpersCaptured = true;
    const record: ElectronMainProcessSample = {
      pid: pid!, reason: "electron-helper-processes", status: "starting",
      output: "", truncated: false,
    };
    samples.push(record);
    const timeoutMs = Math.min(
      PROCESS_TABLE_TIMEOUT_MS,
      deadlineAt - Date.now() - SAMPLE_HEADROOM_MS,
    );
    if (timeoutMs <= 0) {
      record.status = "skipped-insufficient-existing-budget";
      return;
    }
    run(record, "/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,command="], timeoutMs,
      MAX_PROCESS_TABLE_BYTES, (status, output) => {
        record.status = status;
        if (status !== "completed") return;
        const helpers = electronHelperProcesses(pid!, output);
        record.output = helpers.length === 0
          ? "no-helper-processes"
          : helpers.map((helper) =>
            `${helper.pid} ${helper.ppid} ${helper.stat} ${helper.role}`).join("\n");
        const gpu = helpers.find((helper) =>
          helper.role === "gpu-process" && helper.ppid === pid);
        if (gpu && ownsLiveMain()) sampleHelper(gpu.pid, deadlineAt);
      });
  };
  if (platform === "darwin") main.once("exit", stop);
  return {
    capture, samples, stop,
    watchQuit: (deadlineAt) => {
      clearWatchdog();
      if (platform === "darwin" && ownsLiveMain()
        && deadlineAt - Date.now()
          >= QUIT_WATCHDOG_MS + MIN_SAMPLE_TIMEOUT_MS + SAMPLE_HEADROOM_MS) {
        watchdog = setTimeout(() => {
          watchdog = null;
          capture("prepared-quit-still-pending", deadlineAt);
          captureHelpers(deadlineAt);
        }, QUIT_WATCHDOG_MS);
        watchdog.unref();
      }
      return clearWatchdog;
    },
  };
}
