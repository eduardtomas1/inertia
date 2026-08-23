import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  expect(processExists(pid)).toBe(false);
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
      await waitForExit(descendantPid);
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
      await waitForExit(descendantPid);
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
      await waitForExit(ptyPid);
    } finally {
      forceCleanup(ptyPid);
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  },
);
