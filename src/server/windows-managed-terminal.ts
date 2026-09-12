import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";

import type { RuntimeOwnedPidProcess } from "../node/runtime-owned-processes";
import { parseWindowsTerminalAuthority, type WindowsTerminalAuthority } from "../node/windows-terminal-authority";

const READY = "INERTIA_TERMINAL_JOB_READY\n";
const STOPPED = "INERTIA_TERMINAL_JOB_STOPPED\n";
const RECEIPT = READY + STOPPED;

/** Preserve raw Windows command lines; quote array arguments by the Win32 rules. */
export function windowsTerminalArguments(args: readonly string[] | string): string {
  if (typeof args === "string") return args;
  return args.map((arg) => `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`).join(" ");
}

export interface WindowsTerminalWatch {
  requestStop(): boolean;
  confirmed(): boolean;
  wait(): Promise<boolean>;
}

/** The private native receipt and normal close must agree. PTY output cannot prove cleanup. */
export function observeWindowsTerminalWatch(child: ChildProcess): WindowsTerminalWatch {
  let output = "";
  let invalid = !child.stdin || !child.stdout || !child.stderr;
  let confirmed = false;
  let stopRequested = false;
  let admitted = false;
  let settle!: (value: boolean) => void;
  const stopped = new Promise<boolean>((resolve) => { settle = resolve; });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (invalid) return;
    if (chunk.length + output.length > RECEIPT.length) { invalid = true; output = ""; }
    else output += String(chunk);
    if (!admitted && output.startsWith(READY)) {
      admitted = true;
      if (!stopRequested && !invalid) child.stdin?.write("A");
    }
    if (invalid) child.stdin?.end();
  });
  // Diagnostics are fixed native categories. Drain them without retaining any
  // process output; stderr can never turn an uncertain stop into success.
  child.stderr?.resume();
  child.stdin?.on("error", () => { invalid = true; });
  child.on("error", () => { invalid = true; settle(false); });
  child.once("close", (code, signal) => {
    confirmed = !invalid && code === 0 && signal === null
      && output === RECEIPT;
    settle(confirmed);
  });
  return {
    requestStop: () => {
      if (!stopRequested) { stopRequested = true; child.stdin?.end(); }
      // Consume even failed control requests: no fallback to a recyclable PID.
      return true;
    },
    confirmed: () => confirmed,
    wait: () => stopped,
  };
}

export function spawnWindowsManagedTerminal(options: {
  authority: WindowsTerminalAuthority | undefined;
  command: string;
  args: readonly string[] | string;
  spawnOwned: (spawnProcess: () => IPty) => RuntimeOwnedPidProcess<IPty>;
  spawnTerminal: (command: string, args: string) => IPty;
  spawnWatcher?: typeof spawnChild;
}): RuntimeOwnedPidProcess<IPty> {
  const authority = parseWindowsTerminalAuthority(options.authority);
  if (!authority) throw new Error("Windows managed terminal authority is unavailable.");
  const token = randomUUID();
  const launcherArgs = windowsTerminalArguments([
    "terminal-launch", token, options.command, windowsTerminalArguments(options.args), authority.sha256,
  ]);
  // CreateProcessW counts UTF-16 code units, including executable and NUL.
  if (windowsTerminalArguments([authority.path]).length + launcherArgs.length + 2 > 32767) {
    throw new Error("The managed terminal command exceeds the Windows command-line limit.");
  }
  // Journal publication completes before the watcher can open the payload gate.
  const owned = options.spawnOwned(() => options.spawnTerminal(authority.path, launcherArgs));
  let watcher: WindowsTerminalWatch;
  try {
    watcher = observeWindowsTerminalWatch((options.spawnWatcher ?? spawnChild)(authority.path, [
      "terminal-watch", token, String(owned.process.pid), String(process.pid),
      authority.sha256,
    ], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: {
        SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
        TEMP: process.env.TEMP, TMP: process.env.TMP,
      },
    }));
  } catch {
    // The guardian's admission timeout closes its sole Job handle. Preserve
    // the durable claim and report uncertainty; never signal the returned PID.
    watcher = { requestStop: () => true, confirmed: () => false, wait: async () => false };
  }
  return {
    process: owned.process,
    confirmStopped: () => watcher.confirmed() && owned.confirmStopped(),
    releaseIfGroupExited: (signal) => {
      if (watcher.confirmed()) owned.releaseIfGroupExited(signal);
    },
    requestPayloadExit: () => false,
    requestGuardianStop: watcher.requestStop,
    waitForGuardianStop: watcher.wait,
  };
}
