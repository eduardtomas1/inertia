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
const GPU_RECOVERY_EXIT_RESERVE_MS = 2_000;
const GPU_RECOVERY_PROBE_RESERVE_MS = 2_000;
const GPU_STALL_NANOSLEEP_SHARE = 0.8;
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
  terminateStalledGpuHelper: (deadlineAt: number, stillStalled: () => boolean) => Promise<boolean>;
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

export function mainThreadNanosleepShare(sample: string): number | null {
  const lines = sample.split(/\r?\n/u);
  const start = lines.findIndex((line) =>
    /^ {4}\d+ Thread_\S+.*\bcom\.apple\.main-thread\b/u.test(line));
  if (start < 0) return null;
  const total = Number(/^ {4}(\d+)/u.exec(lines[start]!)![1]);
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  let sleeping = 0;
  let countedDepth = Number.POSITIVE_INFINITY;
  for (const line of lines.slice(start + 1)) {
    const frame = /^( {4}[+!:| ]*)(\d+) +(.*)$/u.exec(line);
    if (!frame || !frame[1]!.includes("+")) break;
    const depth = frame[1]!.length;
    if (depth > countedDepth) continue;
    countedDepth = Number.POSITIVE_INFINITY;
    if (/^nanosleep\s+\(in libsystem_c\.dylib\)/u.test(frame[3]!)) {
      sleeping += Number(frame[2]);
      countedDepth = depth;
    }
  }
  return Math.min(1, sleeping / total);
}

export function gpuMainThreadStall(sample: string): string | null {
  const share = mainThreadNanosleepShare(sample);
  return share !== null && share >= GPU_STALL_NANOSLEEP_SHARE
    ? `main-thread-nanosleep=${Math.round(share * 100)}%`
    : null;
}

export function createElectronMainProcessDiagnostic(
  main: ChildProcess,
  dependencies: {
    platform?: NodeJS.Platform;
    spawn?: typeof spawn;
    killGroup?: (pid: number) => void;
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): ElectronMainProcessDiagnostic {
  const platform = dependencies.platform ?? process.platform;
  const spawnSample = dependencies.spawn ?? spawn;
  const killGroup = dependencies.killGroup ?? ((pid: number) => {
    process.kill(-pid, "SIGKILL");
  });
  const signalProcess = dependencies.signalProcess ?? ((target: number, signal: NodeJS.Signals) => {
    process.kill(target, signal);
  });
  const pid = main.pid;
  const samples: ElectronMainProcessSample[] = [];
  const active = new Set<() => void>();
  let mainSamples = 0;
  let mainSampling = false;
  let helpersCaptured = false;
  let helperEvidencePending = false;
  const helperEvidenceWaiters = new Set<() => void>();
  const validatedHelperSamples = new Map<ElectronMainProcessSample, string>();
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
  const sampleHelper = (helperPid: number, deadlineAt: number, done: () => void): void => {
    readHelperIdentity(helperPid, deadlineAt, (before) => {
      if (before === null || !ownsLiveMain()) return done();
      const record: ElectronMainProcessSample = {
        pid: helperPid, reason: "gpu-helper-still-pending", status: "starting",
        output: "", truncated: false,
      };
      samples.push(record);
      const timeoutMs = sampleBudget(deadlineAt);
      if (timeoutMs < MIN_SAMPLE_TIMEOUT_MS) {
        record.status = "skipped-insufficient-existing-budget";
        return done();
      }
      run(record, "/usr/bin/sample", [
        String(helperPid), "1", "10", "-file", "/dev/stdout",
      ], timeoutMs, MAX_SAMPLE_BYTES, (status, output) => {
        record.status = "validating-helper-identity";
        readHelperIdentity(helperPid, deadlineAt, (after) => {
          if (after !== before) {
            record.status = "discarded-helper-identity-changed";
          } else {
            record.status = status;
            record.output = output;
            if (status === "completed") validatedHelperSamples.set(record, before);
          }
          done();
        });
      });
    });
  };
  const settleHelperEvidence = (): void => {
    helperEvidencePending = false;
    for (const waiter of helperEvidenceWaiters) waiter();
  };
  const afterHelperEvidence = (latestAt: number, next: () => void): void => {
    if (!helperEvidencePending) return next();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      active.delete(release);
      helperEvidenceWaiters.delete(release);
      next();
    };
    const timer = setTimeout(release, Math.max(0, latestAt - Date.now()));
    timer.unref();
    active.add(release);
    helperEvidenceWaiters.add(release);
  };
  const readHelperTable = (
    record: ElectronMainProcessSample,
    deadlineAt: number,
    onHelpers: (helpers: ElectronHelperProcess[] | null) => void,
  ): void => {
    const timeoutMs = Math.min(
      PROCESS_TABLE_TIMEOUT_MS,
      deadlineAt - Date.now() - SAMPLE_HEADROOM_MS,
    );
    if (timeoutMs <= 0) {
      record.status = "skipped-insufficient-existing-budget";
      onHelpers(null);
      return;
    }
    run(record, "/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,command="], timeoutMs,
      MAX_PROCESS_TABLE_BYTES, (status, output) => {
        record.status = status;
        onHelpers(status === "completed" ? electronHelperProcesses(pid!, output) : null);
      });
  };
  const directGpuHelpers = (helpers: ElectronHelperProcess[]): ElectronHelperProcess[] =>
    helpers.filter((helper) => helper.role === "gpu-process" && helper.ppid === pid);
  const findGpuHelper = (
    deadlineAt: number,
    onGpu: (gpu: ElectronHelperProcess | null, status: string) => void,
  ): void => {
    if (!ownsLiveMain()) return onGpu(null, "main-process-exited");
    const probe: ElectronMainProcessSample = {
      pid: pid!, reason: "gpu-helper-table", status: "starting", output: "", truncated: false,
    };
    readHelperTable(probe, deadlineAt, (helpers) => {
      if (!helpers) return onGpu(null, `helper-table-${probe.status}`);
      const gpus = directGpuHelpers(helpers);
      onGpu(gpus.length === 1 ? gpus[0]! : null,
        gpus.length === 0 ? "no-gpu-helper" : "ambiguous-gpu-helper");
    });
  };
  const gpuStallEvidence = (gpu: ElectronHelperProcess, identity: string): string | null => {
    if (gpu.stat.startsWith("T")) return "stopped";
    for (const [sample, sampledIdentity] of validatedHelperSamples) {
      if (sample.pid !== gpu.pid || sampledIdentity !== identity) continue;
      const stall = gpuMainThreadStall(sample.output);
      if (stall) return stall;
    }
    return null;
  };
  const terminateStalledGpuHelper = (
    deadlineAt: number,
    stillStalled: () => boolean,
  ): Promise<boolean> => new Promise<boolean>((resolve) => {
    if (platform !== "darwin" || !ownsLiveMain()) return resolve(false);
    const record: ElectronMainProcessSample = {
      pid: pid!, reason: "gpu-helper-recovery", status: "waiting-for-helper-evidence",
      output: "", truncated: false,
    };
    samples.push(record);
    const finish = (status: string, terminated = false): void => {
      record.status = status;
      resolve(terminated);
    };
    const probeDeadlineAt = deadlineAt - GPU_RECOVERY_EXIT_RESERVE_MS;
    afterHelperEvidence(probeDeadlineAt - GPU_RECOVERY_PROBE_RESERVE_MS, () => {
      record.status = "identifying-gpu-helper";
      findGpuHelper(probeDeadlineAt, (gpu, status) => {
        if (!gpu) return finish(status);
        record.output = `${gpu.pid} ${gpu.ppid} ${gpu.stat} ${gpu.role}`;
        readHelperIdentity(gpu.pid, probeDeadlineAt, (before) => {
          if (before === null) return finish("helper-identity-unavailable");
          findGpuHelper(probeDeadlineAt, (confirmed, confirmStatus) => {
            if (!confirmed) return finish(confirmStatus);
            if (confirmed.pid !== gpu.pid) return finish("discarded-helper-identity-changed");
            record.output = `${confirmed.pid} ${confirmed.ppid} ${confirmed.stat} ${confirmed.role}`;
            readHelperIdentity(gpu.pid, probeDeadlineAt, (after) => {
              if (after !== before) return finish("discarded-helper-identity-changed");
              if (!ownsLiveMain()) return finish("main-process-exited");
              if (!stillStalled()) return finish("window-destroy-returned");
              const stall = gpuStallEvidence(confirmed, before);
              if (stall === null) return finish("gpu-stall-unconfirmed");
              record.output += ` stall=${stall}`;
              try {
                signalProcess(gpu.pid, "SIGKILL");
              } catch (error) {
                return finish(`signal-failed: ${String(error).slice(0, 512)}`);
              }
              finish("terminated", true);
            });
          });
        });
      });
    });
  });
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
    helperEvidencePending = true;
    const record: ElectronMainProcessSample = {
      pid: pid!, reason: "electron-helper-processes", status: "starting",
      output: "", truncated: false,
    };
    samples.push(record);
    readHelperTable(record, deadlineAt, (helpers) => {
      if (!helpers) return settleHelperEvidence();
      record.output = helpers.length === 0
        ? "no-helper-processes"
        : helpers.map((helper) =>
          `${helper.pid} ${helper.ppid} ${helper.stat} ${helper.role}`).join("\n");
      const gpu = directGpuHelpers(helpers)[0];
      if (gpu && ownsLiveMain()) sampleHelper(gpu.pid, deadlineAt, settleHelperEvidence);
      else settleHelperEvidence();
    });
  };
  if (platform === "darwin") main.once("exit", stop);
  return {
    capture, samples, stop, terminateStalledGpuHelper,
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
