import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const root = join(import.meta.dirname, "..", "..");

test("normalizes Linux lsof socket endpoints without changing pipe or macOS identities", async () => {
  const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
  const { lsofPipeIdentity } = await import(moduleUrl) as {
    lsofPipeIdentity: (
      record: { device: string; inode: string; name: string },
      platform: NodeJS.Platform,
    ) => string | null;
  };
  const parentSocket = {
    device: "0x0000000000000000",
    inode: "167904",
    name: "type=STREAM ->INO=167905 30224,node,1u",
  };
  const childSocket = {
    device: "0x0000000000000000",
    inode: "167905",
    name: "type=STREAM ->INO=167904 30183,node,22u",
  };

  expect(lsofPipeIdentity(parentSocket, "linux")).toBe("socket:167904:167905");
  expect(lsofPipeIdentity(childSocket, "linux")).toBe("socket:167904:167905");
  expect(lsofPipeIdentity({
    device: "",
    inode: "9001",
    name: "pipe",
  }, "linux")).toBe("inode::9001");
  expect(lsofPipeIdentity({
    device: "0x0",
    inode: "167904",
    name: "type=STREAM",
  }, "linux")).toBeNull();
  expect(lsofPipeIdentity(parentSocket, "darwin")).toBe(
    "inode:0x0000000000000000:167904",
  );
});

test("uses bounded endpoint and descriptor-only lsof modes on Linux and macOS", async () => {
  const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
  const { lsofPlatformArgs } = await import(moduleUrl) as {
    lsofPlatformArgs: (platform: NodeJS.Platform) => string[];
  };

  expect(lsofPlatformArgs("linux")).toEqual(["-E"]);
  expect(lsofPlatformArgs("darwin")).toEqual(["-X"]);
  expect(lsofPlatformArgs("win32")).toEqual([]);
});

test("retries transient pipe-owner scans without accepting a permanently unreadable scan", async () => {
  const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
  const { readPosixProbePipeOwners } = await import(moduleUrl) as {
    readPosixProbePipeOwners: (
      identities: Set<string>,
      dependencies: {
        readRecords: () => Array<{
          device: string;
          inode: string;
          name: string;
          pid: number;
        }> | null;
        platform: NodeJS.Platform;
        userId: number | null;
      },
    ) => Set<number> | null;
  };
  let reads = 0;
  const identity = "endpoints:0xa:0xb";
  const owners = readPosixProbePipeOwners(new Set([identity]), {
    platform: "darwin",
    readRecords: () => {
      reads += 1;
      return reads === 1
        ? []
        : [{ device: "0xa", inode: "", name: "->0xb", pid: 4301 }];
    },
    // Windows has no process.getuid(). Supplying the validated target UID
    // keeps this parser/scan seam host-portable without changing production.
    userId: 501,
  });

  expect(owners).toEqual(new Set([4301]));
  expect(reads).toBe(2);

  reads = 0;
  expect(readPosixProbePipeOwners(new Set([identity]), {
    platform: "darwin",
    readRecords: () => {
      reads += 1;
      return null;
    },
    userId: 501,
  })).toBeNull();
  expect(reads).toBe(3);

  expect(readPosixProbePipeOwners(new Set([identity]), {
    platform: "darwin",
    readRecords: () => {
      reads += 1;
      return [];
    },
    userId: null,
  })).toBeNull();
  expect(reads).toBe(3);
});

test("bounds parsed lsof ownership output", async () => {
  const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
  const { parseLsofRecords } = await import(moduleUrl) as {
    parseLsofRecords: (output: string) => unknown[] | null;
  };

  expect(parseLsofRecords(
    "p30183\nf22\nd0x0000000000000000\ni167904\n"
      + "ntype=STREAM ->INO=167905 30224,node,1u\n",
  )).toEqual([{
    device: "0x0000000000000000",
    inode: "167904",
    name: "type=STREAM ->INO=167905 30224,node,1u",
    pid: 30183,
  }]);
  expect(parseLsofRecords("x".repeat(1024 * 1024 + 1))).toBeNull();
});

test("retries a raced Linux endpoint snapshot and fails closed without peer data", async () => {
  const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
  const { readPosixProbePipeIdentities } = await import(moduleUrl) as {
    readPosixProbePipeIdentities: (
      child: object,
      readRecords: () => Array<{ device: string; inode: string; name: string; pid: number }>,
      platform: NodeJS.Platform,
    ) => { identities: Set<string>; ownerPids: Set<number> } | null;
  };
  const child = {
    stderr: { _handle: { fd: 20 } },
    stdout: { _handle: { fd: 18 } },
  };
  const missingEndpoints = [
    { device: "0x0", inode: "167904", name: "type=STREAM", pid: 30183 },
    { device: "0x0", inode: "167906", name: "type=STREAM", pid: 30183 },
  ];
  const connectedEndpoints = [
    {
      device: "0x0",
      inode: "167904",
      name: "type=STREAM ->INO=167905 30224,node,1u",
      pid: 30183,
    },
    {
      device: "0x0",
      inode: "167906",
      name: "type=STREAM ->INO=167907 30224,node,2u",
      pid: 30183,
    },
  ];
  let reads = 0;
  const token = readPosixProbePipeIdentities(
    child,
    () => (reads++ === 0 ? missingEndpoints : connectedEndpoints),
    "linux",
  );

  expect(reads).toBe(2);
  expect(token?.identities).toEqual(new Set([
    "socket:167904:167905",
    "socket:167906:167907",
  ]));
  expect(token?.ownerPids).toEqual(new Set([30224]));

  reads = 0;
  expect(readPosixProbePipeIdentities(
    child,
    () => {
      reads += 1;
      return missingEndpoints;
    },
    "linux",
  )).toBeNull();
  expect(reads).toBe(3);
});

test("reacquires a missing ownership token during tracker refresh", async () => {
  const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
  const { createPosixProcessTracker } = await import(moduleUrl) as {
    createPosixProcessTracker: (
      rootPid: number,
      child: object,
      dependencies: {
        readPipeOwners: (identities: Set<string>) => Set<number> | null;
        readPipeToken: () => { identities: Set<string>; ownerPids: Set<number> } | null;
        readProcesses: () => Array<{ groupPid: number; parentPid: number; pid: number }> | null;
      },
    ) => {
      confirmed: boolean;
      ownedPids: Set<number>;
      refresh: () => object | null;
    };
  };
  let tokenReads = 0;
  const identity = "socket:18736:18737";
  const tracker = createPosixProcessTracker(4100, {}, {
    readPipeOwners: (identities) => identities.has(identity) ? new Set([4101]) : null,
    readPipeToken: () => {
      tokenReads += 1;
      return tokenReads === 1
        ? null
        : { identities: new Set([identity]), ownerPids: new Set([4101]) };
    },
    readProcesses: () => [
      { groupPid: 4100, parentPid: 1, pid: 4100 },
      { groupPid: 4101, parentPid: 1, pid: 4101 },
    ],
  });

  expect(tracker.confirmed).toBe(false);
  expect(tracker.refresh()).not.toBeNull();
  expect(tracker.confirmed).toBe(true);
  expect(tracker.ownedPids).toEqual(new Set([4100, 4101]));
  expect(tokenReads).toBe(2);
});

test("keeps a permanently missing ownership token unconfirmed", async () => {
  const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
  const { createPosixProcessTracker } = await import(moduleUrl) as {
    createPosixProcessTracker: (
      rootPid: number,
      child: object,
      dependencies: {
        readPipeOwners: () => Set<number> | null;
        readPipeToken: () => null;
        readProcesses: () => [] | null;
      },
    ) => { confirmed: boolean; refresh: () => object | null };
  };
  const tracker = createPosixProcessTracker(4200, {}, {
    readPipeOwners: () => new Set(),
    readPipeToken: () => null,
    readProcesses: () => [],
  });

  expect(tracker.refresh()).toBeNull();
  expect(tracker.confirmed).toBe(false);
});

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

async function waitForTermination(pid: number): Promise<string | null> {
  const deadline = Date.now() + 5_000;
  let state = processState(pid);
  while (state !== null && !new Set(["X", "Z"]).has(state) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    state = processState(pid);
  }
  if (state !== null && state !== "X" && state !== "Z") {
    throw new Error(`Process ${pid} remained in non-terminal state ${state}.`);
  }
  return state;
}

function forceCleanup(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
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

test.skipIf(process.platform === "win32")(
  "rejects a detached descendant that closes the ownership descriptors",
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "inertia-native-probe-escape-"));
    const pidFile = join(temporaryDirectory, "descendant.pid");
    const rootPidFile = join(temporaryDirectory, "root.pid");
    let descendantPid = 0;
    try {
      const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
      const { probeNativeExecutableWithDependencies } = await import(moduleUrl) as {
        probeNativeExecutableWithDependencies: (
          command: string,
          args: string[],
          options: { environment: NodeJS.ProcessEnv; timeoutMs: number },
          dependencies: {
            processTracker: {
              readPipeOwners: () => Set<number>;
              readPipeToken: () => null;
              readProcesses: () => [];
            };
          },
        ) => Promise<unknown>;
      };
      const probe = probeNativeExecutableWithDependencies(process.execPath, [
        join(import.meta.dirname, "..", "fixtures", "native-executable-probe-child.mjs"),
      ], {
        environment: {
          INERTIA_PROBE_PID_FILE: pidFile,
          INERTIA_PROBE_REDIRECT_DESCENDANT: "1",
          INERTIA_PROBE_ROOT_PID_FILE: rootPidFile,
        },
        // This case proves the close-path ownership verdict, not the deadline
        // path. Keep enough headroom for a cold Node child on a loaded hosted
        // runner while remaining below the production 10-second probe bound.
        timeoutMs: 5_000,
      }, {
        processTracker: {
          readPipeOwners: () => new Set(),
          readPipeToken: () => null,
          readProcesses: () => [],
        },
      });
      const unconfirmedFailure = expect(probe).rejects.toThrow(
        "exited with unconfirmed process ownership",
      );
      const pidFileDeadline = Date.now() + 4_000;
      while (!descendantPid && Date.now() < pidFileDeadline) {
        try {
          descendantPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(processExists(descendantPid)).toBe(true);
      await unconfirmedFailure;
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
          options: {
            environment: NodeJS.ProcessEnv;
            startAfterOwnership: boolean;
            timeoutMs: number;
          },
        ) => Promise<unknown>;
      };
      const probe = probeNativeExecutable(process.execPath, [
        join(root, "scripts", "native-pty-probe.mjs"),
        join(import.meta.dirname, "..", "fixtures", "native-pty-probe-hang.sh"),
      ], {
        environment: {
          INERTIA_NATIVE_PTY_START_GATE: "1",
          INERTIA_PTY_PID_FILE: pidFile,
        },
        startAfterOwnership: true,
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
