import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, readlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function signaledProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function processState(pid: number): string | null {
  if (!signaledProcessExists(pid)) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const state = commandEnd >= 0 ? stat.slice(commandEnd + 2, commandEnd + 3) : "";
      return /^[A-Z]$/u.test(state) ? state : "?";
    } catch {
      return signaledProcessExists(pid) ? "?" : null;
    }
  }
  if (process.platform === "win32") return "R";
  const result = spawnSync(
    "/bin/ps",
    ["-o", "stat=", "-p", String(pid)],
    { encoding: "utf8", shell: false, timeout: 1_000 },
  );
  const state = result.status === 0 ? result.stdout.trim().slice(0, 1) : "";
  return state || (signaledProcessExists(pid) ? "?" : null);
}

function processExists(pid: number): boolean {
  return processState(pid) !== null;
}

function boundedLsof(args: string[]): Record<string, unknown> {
  const executable = "/usr/bin/lsof";
  let executableAvailable = true;
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    executableAvailable = false;
  }
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: {},
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 1_000,
  });
  return {
    args,
    error: result.error?.message ?? null,
    executableAvailable,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr?.slice(0, 4_096) ?? "",
    stdout: result.stdout?.slice(0, 8_192) ?? "",
  };
}

function linuxProcessObservation(pid: number, state: string | null): Record<string, unknown> {
  let stat = "";
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { /* Report absence below. */ }
  const commandEnd = stat.lastIndexOf(")");
  const fields = commandEnd >= 0 ? stat.slice(commandEnd + 2).trim().split(/\s+/u) : [];
  const descriptorTarget = (descriptor: number): string | null => {
    try { return readlinkSync(`/proc/${pid}/fd/${descriptor}`, "utf8"); } catch { return null; }
  };
  const userId = process.getuid?.();
  return {
    fd1: descriptorTarget(1),
    fd2: descriptorTarget(2),
    groupPid: Number(fields[2]) || null,
    lsofChildDescriptors: boundedLsof([
      "-n", "-P", "-a", "-p", String(pid), "-d", "1,2", "-F", "pfdin",
    ]),
    lsofParentDescriptors: boundedLsof([
      "-n", "-P", "-a", "-p", String(process.pid), "-F", "pfdin",
    ]),
    lsofProductionScan: boundedLsof([
      "-n", "-P", "-a", "-u", String(userId), "-d", "1,2", "-F", "pfdin",
    ]),
    parentPid: Number(fields[1]) || null,
    sessionId: Number(fields[3]) || null,
    state,
  };
}

async function waitForTermination(pid: number): Promise<string | null> {
  const deadline = Date.now() + 5_000;
  let state = processState(pid);
  while (state !== null && !new Set(["X", "Z"]).has(state) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    state = processState(pid);
  }
  if (state !== null && state !== "X" && state !== "Z") {
    const observation = process.platform === "linux"
      ? linuxProcessObservation(pid, state)
      : { state };
    throw new Error(
      `Process ${pid} did not reach a terminal state: ${JSON.stringify(observation)}`,
    );
  }
  return state;
}

function forceCleanup(pid: number): void {
  if (!processExists(pid)) return;
  if (process.platform === "win32") {
    const systemRoot = Object.entries(process.env).find(([name]) =>
      ["systemroot", "windir"].includes(name.toLowerCase()))?.[1];
    if (systemRoot && win32.isAbsolute(systemRoot)) {
      spawnSync(win32.join(systemRoot, "System32", "taskkill.exe"), [
        "/pid", String(pid), "/t", "/f",
      ], { stdio: "ignore", windowsHide: true });
    }
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* The process may already be gone. */ }
}

test.skipIf(process.platform === "win32")(
  "tracks an inherited probe pipe when the native executable root exits immediately",
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "inertia-native-probe-"));
    const pidFile = join(temporaryDirectory, "descendant.pid");
    const rootPidFile = join(temporaryDirectory, "root.pid");
    let descendantPid = 0;
    let rootPid = 0;
    try {
      const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
      const { probeNativeExecutable } = await import(moduleUrl) as {
        probeNativeExecutable: (
          command: string,
          args: string[],
          options: { environment: NodeJS.ProcessEnv; timeoutMs: number },
        ) => Promise<unknown>;
      };
      const startedAt = Date.now();
      const probe = probeNativeExecutable(process.execPath, [
        join(import.meta.dirname, "..", "fixtures", "native-executable-probe-child.mjs"),
      ], {
        environment: {
          INERTIA_PROBE_PID_FILE: pidFile,
          INERTIA_PROBE_ROOT_PID_FILE: rootPidFile,
        },
        timeoutMs: 1_000,
      });
      const deadlineFailure = expect(probe).rejects.toThrow("exceeded its 1000ms deadline");
      const pidFileDeadline = Date.now() + 750;
      while (!descendantPid && Date.now() < pidFileDeadline) {
        try {
          descendantPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      const group = spawnSync(
        "/bin/ps",
        ["-o", "pgid=", "-p", String(descendantPid)],
        { encoding: "utf8", shell: false, timeout: 1_000 },
      );
      expect(group.status).toBe(0);
      expect(Number(group.stdout.trim())).toBe(descendantPid);
      rootPid = Number(await readFile(rootPidFile, "utf8"));
      expect(Number.isSafeInteger(rootPid)).toBe(true);
      const rootExitDeadline = Date.now() + 750;
      while (processExists(rootPid) && Date.now() < rootExitDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(processExists(rootPid)).toBe(false);
      expect(processExists(descendantPid)).toBe(true);
      await deadlineFailure;
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      const terminalState = await waitForTermination(descendantPid);
      if (process.platform === "linux") {
        process.stdout.write(
          `Native probe orphan termination state: ${terminalState ?? "reaped"}.\n`,
        );
      }
    } finally {
      forceCleanup(descendantPid);
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "preserves taskkill process-tree cleanup for a live Windows root",
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "inertia-native-probe-win32-"));
    const pidFile = join(temporaryDirectory, "descendant.pid");
    const rootPidFile = join(temporaryDirectory, "root.pid");
    let descendantPid = 0;
    try {
      const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
      const { probeNativeExecutable } = await import(moduleUrl) as {
        probeNativeExecutable: (
          command: string,
          args: string[],
          options: { environment: NodeJS.ProcessEnv; timeoutMs: number },
        ) => Promise<unknown>;
      };
      const probe = probeNativeExecutable(process.execPath, [
        join(import.meta.dirname, "..", "fixtures", "native-executable-probe-child.mjs"),
      ], {
        environment: {
          INERTIA_PROBE_KEEP_ROOT: "1",
          INERTIA_PROBE_PID_FILE: pidFile,
          INERTIA_PROBE_ROOT_PID_FILE: rootPidFile,
        },
        timeoutMs: 1_000,
      });
      const pidFileDeadline = Date.now() + 750;
      while (!descendantPid && Date.now() < pidFileDeadline) {
        try {
          descendantPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      await expect(probe).rejects.toThrow("exceeded its 1000ms deadline");
      await waitForTermination(descendantPid);
    } finally {
      forceCleanup(descendantPid);
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "terminates the separately grouped native PTY command on timeout",
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "inertia-native-pty-probe-"));
    const pidFile = join(temporaryDirectory, "pty.pid");
    let ptyPid = 0;
    try {
      const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
      const { probeNativeExecutable } = await import(moduleUrl) as {
        probeNativeExecutable: (
          command: string,
          args: string[],
          options: { environment: NodeJS.ProcessEnv; timeoutMs: number },
        ) => Promise<unknown>;
      };
      const probe = probeNativeExecutable(process.execPath, [
        join(root, "scripts", "native-pty-probe.mjs"),
        join(import.meta.dirname, "..", "fixtures", "native-pty-probe-hang.sh"),
      ], {
        environment: { INERTIA_PTY_PID_FILE: pidFile },
        timeoutMs: 1_000,
      });
      const deadlineFailure = expect(probe).rejects.toThrow("exceeded its 1000ms deadline");
      const pidFileDeadline = Date.now() + 750;
      while (!ptyPid && Date.now() < pidFileDeadline) {
        try {
          ptyPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      expect(Number.isSafeInteger(ptyPid)).toBe(true);
      const group = spawnSync(
        "/bin/ps",
        ["-o", "pgid=", "-p", String(ptyPid)],
        { encoding: "utf8", shell: false, timeout: 1_000 },
      );
      expect(group.status).toBe(0);
      expect(Number(group.stdout.trim())).toBe(ptyPid);
      await deadlineFailure;
      await waitForTermination(ptyPid);
    } finally {
      forceCleanup(ptyPid);
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  },
);
