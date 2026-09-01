import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnPty } from "node-pty";
import { afterEach, describe, it, vi } from "vitest";
import { expect } from "vitest";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  awaitRuntimeOwnedProcessCleanupConfirmed,
  runtimeOwnedProcessCleanupConfirmed,
  runtimeOwnedProcessInvocation,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedPidProcess,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry as activateRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";
import { runtimeOwnedPtyInvocation } from "../../src/node/runtime-owned-pty-invocation";
import {
  linuxGuardianTerminalAuthority,
  monitorLinuxGuardianTerminal,
  readLinuxGuardianReadyAsync,
  stopPendingLinuxGuardianAsync,
} from "../../src/node/runtime-owned-process-linux";

const linuxIt = process.platform === "linux" ? it : it.skip;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.lastIndexOf(")");
    return tail < 0 || stat.slice(tail + 2, tail + 3) !== "Z";
  } catch { return false; }
}

function compileGuardian(root: string): string {
  const guardian = join(root, "guardian");
  execFileSync("cc", [
    "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
  ]);
  return guardian;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try { child.kill("SIGKILL"); } catch { /* The exact child is already gone. */ }
  await closed;
}

function waitForChild(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("close", () => resolve()));
}

async function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Linux guardian state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForPtyExit<T>(exited: Promise<T>, timeout = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for the Linux PTY guardian to exit.")),
      timeout,
    );
    exited.then(
      (event) => { clearTimeout(timer); resolve(event); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

describe("Linux runtime process guardian", () => {
  linuxIt("passes the terminal seccomp self-test in the generated static binary", () => {
    const guardian = join(
      process.cwd(),
      "resources/generated/runtime-process-guardian/runtime-process-guardian",
    );
    expect(existsSync(guardian)).toBe(true);
    expect(() => execFileSync(guardian, ["seccomp-selftest"], {
      stdio: "ignore",
      timeout: 5_000,
    }))
      .not.toThrow();
  });

  it("bounds the clean-marker hardening transition before release", () => {
    vi.useFakeTimers();
    const terminalAuthority = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const onTerminal = vi.fn(() => true);
    const onFailure = vi.fn();
    const release = vi.fn(() => true);
    monitorLinuxGuardianTerminal({
      pid: 123, parentPid: 1, processGroupId: 123, startTimeTicks: "456",
      guardianExecutableDevice: "1", guardianExecutableInode: "2",
    }, "/trusted/guardian", onTerminal, onFailure, {
      readComm: () => "inertia-done", terminalAuthority, release,
    });

    vi.advanceTimersByTime(150);
    expect(terminalAuthority).toHaveBeenCalledTimes(3);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith(false);
    expect(release).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("distinguishes an authenticated post-exec terminal from an unexecuted stop", () => {
    vi.useFakeTimers();
    const onTerminal = vi.fn(() => true);
    monitorLinuxGuardianTerminal({
      pid: 123, parentPid: 1, processGroupId: 123, startTimeTicks: "456",
      guardianExecutableDevice: "1", guardianExecutableInode: "2",
    }, "/trusted/guardian", onTerminal, vi.fn(), {
      readComm: () => "inertia-exdone",
      terminalAuthority: () => true,
      release: () => true,
    });

    vi.advanceTimersByTime(50);
    expect(onTerminal).toHaveBeenCalledWith(true);
    vi.useRealTimers();
  });

  it("runs a delayed guardian helper without blocking the runtime event loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-async-helper-")); roots.push(root);
    const helper = join(root, "guardian");
    writeFileSync(helper, "#!/bin/sh\nsleep 0.2\nexit 4\n");
    chmodSync(helper, 0o700);
    let heartbeat = false;
    const ready = readLinuxGuardianReadyAsync(123, helper, process.pid);
    setTimeout(() => { heartbeat = true; }, 20);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(heartbeat).toBe(true);
    await expect(ready).resolves.toBeNull();
  });

  it("allows only one asynchronous terminal release attempt at a time", async () => {
    vi.useFakeTimers();
    const releaseResolvers: Array<(released: boolean) => void> = [];
    const release = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseResolvers.push(resolve);
    }));
    const stop = monitorLinuxGuardianTerminal({
      pid: 123, parentPid: 1, processGroupId: 123, startTimeTicks: "456",
      guardianExecutableDevice: "1", guardianExecutableInode: "2",
    }, "/trusted/guardian", () => true, vi.fn(), {
      readComm: () => "inertia-done",
      terminalAuthority: () => true,
      release,
    });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(release).toHaveBeenCalledOnce();
      releaseResolvers.shift()?.(false);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("keeps terminal authority on the durable identity across a helper upgrade", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-authority-")); roots.push(root);
    const oldGuardian = join(root, "guardian.old");
    const currentGuardian = join(root, "guardian.current");
    writeFileSync(oldGuardian, "old"); writeFileSync(currentGuardian, "new");
    const pid = 123; const procRoot = join(root, "proc");
    mkdirSync(join(procRoot, String(pid), "task", String(pid)), { recursive: true });
    symlinkSync(oldGuardian, join(procRoot, String(pid), "exe"));
    const fields = ["T", "1", String(pid), String(pid), ...Array.from({ length: 15 }, () => "0"), "456"];
    writeFileSync(join(procRoot, String(pid), "stat"), `${pid} (guardian) ${fields.join(" ")}\n`);
    writeFileSync(join(procRoot, String(pid), "status"), [
      "Name:\tinertia-done", "State:\tT (stopped)", "TracerPid:\t0", "Threads:\t1",
      "NoNewPrivs:\t1", "Seccomp:\t2", "Seccomp_filters:\t1", "",
    ].join("\n"));
    writeFileSync(join(procRoot, String(pid), "task", String(pid), "children"), "");
    const old = statSync(oldGuardian, { bigint: true });
    expect(linuxGuardianTerminalAuthority({
      pid, parentPid: 999, processGroupId: pid, startTimeTicks: "456",
      guardianExecutableDevice: String(old.dev), guardianExecutableInode: String(old.ino),
    }, currentGuardian, procRoot)).toBe(true);
    writeFileSync(join(procRoot, String(pid), "status"), [
      "Name:\tinertia-exdone", "State:\tT (stopped)", "TracerPid:\t0", "Threads:\t1",
      "NoNewPrivs:\t1", "Seccomp:\t2", "Seccomp_filters:\t1", "",
    ].join("\n"));
    expect(linuxGuardianTerminalAuthority({
      pid, parentPid: 999, processGroupId: pid, startTimeTicks: "456",
      guardianExecutableDevice: String(old.dev), guardianExecutableInode: String(old.ino),
    }, currentGuardian, procRoot, "inertia-exdone")).toBe(true);
    writeFileSync(join(procRoot, String(pid), "status"), [
      "Name:\tinertia-done", "State:\tT (stopped)", "TracerPid:\t0", "Threads:\t1",
      "NoNewPrivs:\t1", "Seccomp:\t2", "",
    ].join("\n"));
    expect(linuxGuardianTerminalAuthority({
      pid, parentPid: 999, processGroupId: pid, startTimeTicks: "456",
      guardianExecutableDevice: String(old.dev), guardianExecutableInode: String(old.ino),
    }, currentGuardian, procRoot)).toBe(true);
    expect(linuxGuardianTerminalAuthority({
      pid, parentPid: 999, processGroupId: pid, startTimeTicks: "456",
      guardianExecutableDevice: "", guardianExecutableInode: "",
    }, join(root, "deleted-current-helper"), procRoot)).toBe(false);
  });

  linuxIt("drains a double-fork setsid descendant after its runtime parent crashes", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-guardian-")); roots.push(root);
    const guardian = join(root, "guardian");
    const payload = join(root, "payload");
    const descendantPid = join(root, "descendant.pid");
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
    ]);
    execFileSync(guardian, ["seccomp-selftest"]);
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "tests/fixtures/linux-double-fork.c"), "-o", payload,
    ]);

    const harness = spawn(process.execPath, [
      join(process.cwd(), "tests/fixtures/linux-guardian-parent.cjs"),
      guardian, payload, descendantPid, join(root, "guardian.pid"),
    ], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      harness.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`harness exited ${code}`)));
    });
    await waitFor(() => {
      try { return readFileSync(descendantPid, "utf8").trim().length > 0; } catch { return false; }
    });
    const guardianPid = Number(readFileSync(join(root, "guardian.pid"), "utf8"));
    const escapedPid = Number(readFileSync(descendantPid, "utf8"));
    await waitFor(() => {
      try {
        return readFileSync(`/proc/${guardianPid}/comm`, "utf8").trim() === "inertia-exdone"
          && !exists(escapedPid);
      } catch { return false; }
    });
    const identity = execFileSync(guardian, ["identity", String(guardianPid)], { encoding: "utf8" }).trim().split("|");
    const executable = statSync(guardian, { bigint: true });
    execFileSync(guardian, [
      "signal", String(guardianPid), identity[3]!,
      String(executable.dev), String(executable.ino), "kill",
    ]);
    await waitFor(() => !exists(guardianPid));
  }, 15_000);

  linuxIt("routes forced cancellation through the guardian drain", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-force-")); roots.push(root);
    const guardian = join(root, "guardian");
    const payload = join(root, "payload");
    const descendantPid = join(root, "descendant.pid");
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian]);
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "tests/fixtures/linux-double-fork.c"), "-o", payload]);
    const generation = "30000000-0000-4000-8000-000000000003:1";
    const boot = "test:40000000-0000-4000-8000-000000000004";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    try {
      const invocation = runtimeOwnedProcessInvocation(payload, [descendantPid, "keep-root"]);
      const child = spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args, {
        detached: true, stdio: "ignore",
      }));
      await waitFor(() => {
        try { return exists(Number(readFileSync(descendantPid, "utf8").trim())); } catch { return false; }
      });
      const escapedPid = Number(readFileSync(descendantPid, "utf8").trim());
      await expect(terminateProcessTreeAndWait(child, true, {
        platform: "linux", waitMs: 3_000,
      })).resolves.toBe(true);
      expect(exists(escapedPid)).toBe(false);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toEqual([]);
    } finally {
      deactivate?.();
    }
  }, 15_000);

  linuxIt("never falls back to a raw process signal when exact stop is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-stop-unavailable-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "f0000000-0000-4000-8000-00000000000f:1";
    const boot = "test:10000000-0000-4000-8000-000000000010";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const invocation = runtimeOwnedProcessInvocation("/bin/sleep", ["60"]);
    const child = spawnRuntimeOwnedProcess(() => spawn(
      invocation.command,
      invocation.args,
      { detached: true, stdio: "ignore" },
    ));
    await waitFor(() => new RuntimeOwnedProcessJournal(root, {
      platform: "linux", darwinGuardianPath: guardian,
    }).records(generation)?.[0]?.state === "owned");
    const movedGuardian = `${guardian}.moved`;
    renameSync(guardian, movedGuardian);
    const rawKill = vi.fn<typeof process.kill>(() => true);
    try {
      await expect(terminateProcessTreeAndWait(child, true, {
        platform: "linux",
        killProcess: rawKill,
        waitMs: 25,
      })).resolves.toBe(false);
      expect(rawKill).not.toHaveBeenCalled();
      expect(exists(child.pid!)).toBe(true);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: movedGuardian,
      }).records(generation)).toMatchObject([{ state: "owned" }]);
    } finally {
      renameSync(movedGuardian, guardian);
      await terminateProcessTreeAndWait(child, true, {
        platform: "linux",
        waitMs: 3_000,
      });
      deactivate?.();
    }
  }, 15_000);

  linuxIt("lets terminal monitoring retire a done guardian without raw fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-done-stop-")); roots.push(root);
    const guardian = compileGuardian(root);
    const movedGuardian = `${guardian}.moved`;
    const releaseMarker = join(root, "release.marker");
    const generation = "11000000-0000-4000-8000-000000000011:1";
    const boot = "test:12000000-0000-4000-8000-000000000012";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const invocation = runtimeOwnedProcessInvocation(process.execPath, [
      "-e",
      `const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseMarker)})){clearInterval(timer);process.exit(0)}},10)`,
    ]);
    const child = spawnRuntimeOwnedProcess(() => spawn(
      invocation.command,
      invocation.args,
      { detached: true, stdio: "ignore" },
    ));
    const rawKill = vi.fn<typeof process.kill>(() => true);
    await waitFor(() => new RuntimeOwnedProcessJournal(root, {
      platform: "linux", darwinGuardianPath: guardian,
    }).records(generation)?.[0]?.state === "owned");
    renameSync(guardian, movedGuardian);
    try {
      writeFileSync(releaseMarker, "release\n", { encoding: "utf8", mode: 0o600 });
      await waitFor(() => {
        return new RuntimeOwnedProcessJournal(root, {
          platform: "linux", darwinGuardianPath: movedGuardian,
        }).records(generation)?.[0]?.state === "retiring";
      });
      await expect(terminateProcessTreeAndWait(child, true, {
        platform: "linux",
        killProcess: rawKill,
        waitMs: 25,
      })).resolves.toBe(false);
      expect(rawKill).not.toHaveBeenCalled();
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: movedGuardian,
      }).records(generation)).toMatchObject([{ state: "retiring" }]);
      renameSync(movedGuardian, guardian);
      await waitForChild(child);
      await waitFor(() => new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)?.length === 0);
    } finally {
      if (existsSync(movedGuardian)) renameSync(movedGuardian, guardian);
      await stopChild(child);
      deactivate?.();
    }
  }, 15_000);

  linuxIt("waits for an active guardian monitor before confirming runtime cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-cleanup-wait-")); roots.push(root);
    const guardian = compileGuardian(root);
    const releaseMarker = join(root, "release.marker");
    const generation = "15000000-0000-4000-8000-000000000015:1";
    const boot = "test:16000000-0000-4000-8000-000000000016";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const invocation = runtimeOwnedProcessInvocation(process.execPath, [
      "-e",
      `const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseMarker)})){clearInterval(timer);process.exit(0)}},10)`,
    ]);
    const child = spawnRuntimeOwnedProcess(() => spawn(
      invocation.command,
      invocation.args,
      { detached: true, stdio: "ignore" },
    ));
    try {
      const cleanup = awaitRuntimeOwnedProcessCleanupConfirmed();
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(releaseMarker, "release\n", { encoding: "utf8", mode: 0o600 });
      await expect(cleanup).resolves.toBe(true);
      await waitForChild(child);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toEqual([]);
    } finally {
      await stopChild(child);
      deactivate?.();
    }
  }, 15_000);

  linuxIt("keeps a bounded burst of fast native payloads admissible after owned advances", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-fast-payload-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "21000000-0000-4000-8000-000000000021:1";
    const boot = "test:22000000-0000-4000-8000-000000000022";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const runFastPayload = async (): Promise<void> => {
      const invocation = runtimeOwnedProcessInvocation("/bin/true", []);
      const child = spawnRuntimeOwnedProcess(() => spawn(
        invocation.command,
        invocation.args,
        { detached: true, stdio: "ignore" },
      ));
      await waitForChild(child);
    };
    try {
      await Promise.all(Array.from({ length: 64 }, runFastPayload));
      await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
      await runFastPayload();
      await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toEqual([]);
    } finally {
      deactivate?.();
    }
  }, 45_000);

  linuxIt("retries a transient retiring-claim release without losing cleanup proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-release-retry-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "17000000-0000-4000-8000-000000000017:1";
    const boot = "test:18000000-0000-4000-8000-000000000018";
    const releaseRetiring = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "releaseRetiring",
    ).mockReturnValueOnce(false);
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const invocation = runtimeOwnedProcessInvocation(process.execPath, [
      "-e",
      "process.exit(0)",
    ]);
    const child = spawnRuntimeOwnedProcess(() => spawn(
      invocation.command,
      invocation.args,
      { detached: true, stdio: "ignore" },
    ));
    try {
      await waitForChild(child);
      await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
      expect(releaseRetiring).toHaveBeenCalledTimes(2);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toEqual([]);
    } finally {
      releaseRetiring.mockRestore();
      await stopChild(child);
      deactivate?.();
    }
  }, 15_000);

  linuxIt("keeps a retiring claim durable when both bounded releases fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-release-fail-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "19000000-0000-4000-8000-000000000019:1";
    const boot = "test:20000000-0000-4000-8000-000000000020";
    const releaseRetiring = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "releaseRetiring",
    ).mockReturnValue(false);
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const invocation = runtimeOwnedProcessInvocation(process.execPath, [
      "-e",
      "process.exit(0)",
    ]);
    const child = spawnRuntimeOwnedProcess(() => spawn(
      invocation.command,
      invocation.args,
      { detached: true, stdio: "ignore" },
    ));
    try {
      await waitForChild(child);
      await waitFor(() => releaseRetiring.mock.calls.length === 2);
      expect(runtimeOwnedProcessCleanupConfirmed()).toBe(false);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toMatchObject([{ state: "retiring" }]);
    } finally {
      releaseRetiring.mockRestore();
      deactivate?.();
    }
  }, 15_000);

  linuxIt("owns and retires a PID-backed terminal through the guardian", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-pty-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "50000000-0000-4000-8000-000000000005:1";
    const boot = "test:60000000-0000-4000-8000-000000000006";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    try {
      const invocation = runtimeOwnedPtyInvocation("/bin/sleep", ["60"]);
      if (!Array.isArray(invocation.args)) throw new Error("Expected guarded PTY arguments.");
      const owned = spawnRuntimeOwnedPidProcess(() => spawnPty(
        invocation.command,
        [...invocation.args],
        { cwd: root, env: { PATH: "/usr/bin:/bin" } },
      ), { darwinGuardianCommand: invocation.command });
      await waitFor(() => new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)?.[0]?.state === "owned");
      const exited = new Promise<void>((resolve) => {
        owned.process.onExit(({ signal }) => {
          owned.releaseIfGroupExited(signal);
          resolve();
        });
      });
      expect(owned.requestGuardianStop()).toBe(true);
      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      await exited;
      await waitFor(() => new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)?.length === 0);
      expect(owned.confirmStopped()).toBe(true);
    } finally {
      deactivate?.();
    }
  }, 15_000);

  linuxIt("preserves a natural PTY exit while the payload temporarily closes its slave", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-pty-natural-exit-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "52000000-0000-4000-8000-000000000005:1";
    const boot = "test:62000000-0000-4000-8000-000000000006";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    let cleanup: (() => Promise<void>) | null = null;
    try {
      const invocation = runtimeOwnedPtyInvocation(process.execPath, [
        "-e",
        [
          'const { closeSync } = require("node:fs");',
          "closeSync(0); closeSync(1); closeSync(2);",
          "setTimeout(() => process.exit(0), 200);",
        ].join(""),
      ]);
      if (!Array.isArray(invocation.args)) throw new Error("Expected guarded PTY arguments.");
      const owned = spawnRuntimeOwnedPidProcess(() => spawnPty(
        invocation.command,
        [...invocation.args],
        { cwd: root, env: { PATH: "/usr/bin:/bin" } },
      ), { darwinGuardianCommand: invocation.command });
      const exited = new Promise<{
        exitCode: number;
        signal: number | undefined;
      }>((resolve) => {
        owned.process.onExit((event) => {
          owned.releaseIfGroupExited(event.signal);
          resolve({ exitCode: event.exitCode, signal: event.signal });
        });
      });
      cleanup = async () => {
        if (owned.confirmStopped()) return;
        owned.requestGuardianStop();
        await waitForPtyExit(exited);
        await waitFor(() => owned.confirmStopped());
      };

      await expect(waitForPtyExit(exited)).resolves.toEqual({ exitCode: 0, signal: 0 });
      await waitFor(() => new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)?.length === 0);
      expect(owned.confirmStopped()).toBe(true);
    } finally {
      try { await cleanup?.(); } finally { deactivate?.(); }
    }
  }, 15_000);

  linuxIt("consumes an immediate PID-backed stop before guardian admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-pty-immediate-stop-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "51000000-0000-4000-8000-000000000005:1";
    const boot = "test:61000000-0000-4000-8000-000000000006";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    try {
      const invocation = runtimeOwnedPtyInvocation("/bin/sleep", ["60"]);
      if (!Array.isArray(invocation.args)) throw new Error("Expected guarded PTY arguments.");
      const owned = spawnRuntimeOwnedPidProcess(() => spawnPty(
        invocation.command,
        [...invocation.args],
        { cwd: root, env: { PATH: "/usr/bin:/bin" } },
      ), { darwinGuardianCommand: invocation.command });
      const exited = new Promise<void>((resolve) => {
        owned.process.onExit(({ signal }) => {
          owned.releaseIfGroupExited(signal);
          resolve();
        });
      });

      expect(owned.requestGuardianStop()).toBe(true);
      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      await exited;
      await waitFor(() => new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)?.length === 0);
      expect(owned.confirmStopped()).toBe(true);
    } finally {
      deactivate?.();
    }
  }, 15_000);

  linuxIt("consumes an exact-stop failure for a PID-backed terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-pty-stop-failure-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "13000000-0000-4000-8000-000000000013:1";
    const boot = "test:14000000-0000-4000-8000-000000000014";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const invocation = runtimeOwnedPtyInvocation("/bin/sleep", ["60"]);
    if (!Array.isArray(invocation.args)) throw new Error("Expected guarded PTY arguments.");
    const owned = spawnRuntimeOwnedPidProcess(() => spawnPty(
      invocation.command,
      [...invocation.args],
      { cwd: root, env: { PATH: "/usr/bin:/bin" } },
    ), { darwinGuardianCommand: invocation.command });
    await waitFor(() => new RuntimeOwnedProcessJournal(root, {
      platform: "linux", darwinGuardianPath: guardian,
    }).records(generation)?.[0]?.state === "owned");
    const exited = new Promise<void>((resolve) => {
      owned.process.onExit(({ signal }) => {
        owned.releaseIfGroupExited(signal);
        resolve();
      });
    });
    const movedGuardian = `${guardian}.moved`;
    renameSync(guardian, movedGuardian);
    try {
      expect(owned.requestGuardianStop()).toBe(true);
      await expect(owned.waitForGuardianStop()).resolves.toBe(false);
      expect(exists(owned.process.pid)).toBe(true);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: movedGuardian,
      }).records(generation)).toMatchObject([{ state: "owned" }]);
    } finally {
      renameSync(movedGuardian, guardian);
      owned.requestGuardianStop();
      await exited;
      deactivate?.();
    }
  }, 15_000);

  linuxIt("fails closed when the guardian claim cannot be persisted", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-claim-failure-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "70000000-0000-4000-8000-000000000007:1";
    const boot = "test:80000000-0000-4000-8000-000000000008";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const invocation = runtimeOwnedProcessInvocation("/bin/sh", ["-c", `touch ${join(root, "ran")}`]);
    let child: ChildProcess | null = null;
    let childPid = 0;
    const claim = vi.spyOn(RuntimeOwnedProcessJournal.prototype, "claim")
      .mockImplementationOnce(() => {
        throw new Error("The spawned process ownership could not be persisted.");
      });
    try {
      spawnRuntimeOwnedProcess(() => {
        child = spawn(invocation.command, invocation.args, { detached: true, stdio: "ignore" });
        childPid = child.pid ?? 0;
        return child;
      });
      await waitFor(() => claim.mock.calls.length === 1);
      const journal = new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      });
      const duringCleanup = journal.records(generation);
      expect(duringCleanup).not.toBeNull();
      expect(duringCleanup?.every((record) => record.state === "pending")).toBe(true);
      expect(() => spawnRuntimeOwnedProcess(() => spawn("/bin/true")))
        .toThrow("tainted until restart");
      expect(() => statSync(join(root, "ran"))).toThrow();
      await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
      expect(journal.records(generation)).toEqual([]);
      expect(childPid).toBeGreaterThan(1);
      expect(exists(childPid)).toBe(false);
      expect(() => statSync(join(root, "ran"))).toThrow();
    } finally {
      claim.mockRestore();
      if (child) await stopChild(child);
      deactivate?.();
    }
  }, 15_000);

  linuxIt("stops and retires a pre-identity guardian when readiness cannot be published", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-ready-failure-")); roots.push(root);
    const guardian = join(root, "guardian");
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-DINERTIA_RUNTIME_GUARDIAN_TEST_REJECT_READY=1",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
    ]);
    const generation = "71000000-0000-4000-8000-000000000007:1";
    const boot = "test:81000000-0000-4000-8000-000000000008";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const unrelated = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
    const marker = join(root, "ran");
    const invocation = runtimeOwnedProcessInvocation(
      "/bin/sh", ["-c", `touch ${marker}`],
    );
    let child: ChildProcess | null = null;
    try {
      await expect(stopPendingLinuxGuardianAsync(
        unrelated.pid ?? 0,
        guardian,
        process.pid,
      )).resolves.toBe(false);
      expect(exists(unrelated.pid ?? 0)).toBe(true);

      child = spawnRuntimeOwnedProcess(() => spawn(
        invocation.command,
        invocation.args,
        { detached: true, stdio: "ignore" },
      ));
      await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
      await waitForChild(child);

      expect(child.exitCode).toBe(143);
      expect(child.signalCode).toBeNull();
      expect(existsSync(marker)).toBe(false);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toEqual([]);
    } finally {
      if (child) await stopChild(child);
      await stopChild(unrelated);
      deactivate?.();
    }
  }, 15_000);

  linuxIt("rejects pre-identity cleanup when the exact guardian drain fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-pending-drain-failure-"));
    roots.push(root);
    const guardian = join(root, "guardian");
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-DINERTIA_RUNTIME_GUARDIAN_TEST_REJECT_DRAIN=1",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
    ]);
    const executable = statSync(guardian, { bigint: true });
    const marker = join(root, "ran");
    const child = spawn(guardian, [
      "watch", String(process.pid), String(executable.dev), String(executable.ino),
      "--", "/bin/sh", "-c", `touch ${marker}`,
    ], { detached: true, stdio: "ignore" });
    const pid = child.pid ?? 0;
    try {
      await expect(readLinuxGuardianReadyAsync(
        pid,
        guardian,
        process.pid,
      )).resolves.not.toBeNull();
      await expect(stopPendingLinuxGuardianAsync(
        pid,
        guardian,
        process.pid,
      )).resolves.toBe(false);
      expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("inertia-bad");
      expect(existsSync(marker)).toBe(false);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* The exact group is gone. */ }
      await stopChild(child);
    }
  }, 15_000);

  linuxIt("does not accept leader exit while the pre-identity process group survives", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-pending-group-survival-"));
    roots.push(root);
    const guardian = join(root, "guardian");
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-DINERTIA_RUNTIME_GUARDIAN_TEST_CRASH_STOP_PENDING=1",
      "-DINERTIA_RUNTIME_GUARDIAN_TEST_HOLD_GATE_FAILURE=1",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
    ]);
    const executable = statSync(guardian, { bigint: true });
    const marker = join(root, "ran");
    const child = spawn(guardian, [
      "watch", String(process.pid), String(executable.dev), String(executable.ino),
      "--", "/bin/sh", "-c", `touch ${marker}`,
    ], { detached: true, stdio: "ignore" });
    const pid = child.pid ?? 0;
    try {
      await expect(readLinuxGuardianReadyAsync(
        pid,
        guardian,
        process.pid,
      )).resolves.not.toBeNull();
      await expect(stopPendingLinuxGuardianAsync(
        pid,
        guardian,
        process.pid,
      )).resolves.toBe(false);
      await waitForChild(child);
      expect(() => process.kill(-pid, 0)).not.toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* The exact group is gone. */ }
      await stopChild(child);
    }
  }, 15_000);

  linuxIt("rejects a guardian with the wrong runtime-parent identity before exec", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-parent-mismatch-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "90000000-0000-4000-8000-000000000009:1";
    const boot = "test:a0000000-0000-4000-8000-00000000000a";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const executable = statSync(guardian, { bigint: true });
    const wrongOwner = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    let child: ChildProcess | null = null;
    try {
      spawnRuntimeOwnedProcess(() => {
        child = spawn(guardian, [
          "watch", String(wrongOwner.pid), String(executable.dev), String(executable.ino),
          "--", "/bin/sh", "-c", `touch ${join(root, "ran")}`,
        ], { detached: true, stdio: "ignore" });
        return child;
      });
      await waitFor(() => new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)?.[0]?.state === "pending");
      if (!child) throw new Error("The wrong-parent guardian did not spawn.");
      await waitForChild(child);
      expect(() => spawnRuntimeOwnedProcess(() => spawn("/bin/true")))
        .toThrow("tainted until restart");
      expect(() => statSync(join(root, "ran"))).toThrow();
    } finally {
      if (child) await stopChild(child);
      await stopChild(wrongOwner);
      deactivate?.();
    }
  }, 15_000);

  linuxIt("retains ambiguous authorization failure and taints later admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-auth-failure-")); roots.push(root);
    const guardian = compileGuardian(root);
    const generation = "b0000000-0000-4000-8000-00000000000b:1";
    const boot = "test:c0000000-0000-4000-8000-00000000000c";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const invocation = runtimeOwnedProcessInvocation("/bin/sh", ["-c", `touch ${join(root, "ran")}`]);
    const own = vi.spyOn(RuntimeOwnedProcessJournal.prototype, "own")
      .mockReturnValueOnce(null);
    let child: ChildProcess | null = null;
    try {
      spawnRuntimeOwnedProcess(() => {
        child = spawn(invocation.command, invocation.args, { detached: true, stdio: "ignore" });
        return child;
      });
      await waitFor(() => own.mock.calls.length === 1);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toMatchObject([{ state: "preauth" }]);
      expect(() => spawnRuntimeOwnedProcess(() => spawn("/bin/true")))
        .toThrow("tainted until restart");
      expect(() => statSync(join(root, "ran"))).toThrow();
    } finally {
      own.mockRestore();
      if (child) await stopChild(child);
      deactivate?.();
    }
  }, 15_000);

  linuxIt("keeps inactive registry claims durably owned without late monitor mutation", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "inertia-linux-replaced-a-")); roots.push(firstRoot);
    const secondRoot = mkdtempSync(join(tmpdir(), "inertia-linux-replaced-b-")); roots.push(secondRoot);
    const guardian = compileGuardian(firstRoot);
    const generation = "d0000000-0000-4000-8000-00000000000d:1";
    const boot = "test:e0000000-0000-4000-8000-00000000000e";
    const deactivateFirst = activateRuntimeOwnedProcessRegistry(firstRoot, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    const children = ["0.1", "0.2"].map((duration) => {
      const invocation = runtimeOwnedProcessInvocation("/bin/sleep", [duration]);
      return spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args, {
        detached: true, stdio: "ignore",
      }));
    });
    await waitFor(() => new RuntimeOwnedProcessJournal(firstRoot, {
      platform: "linux", darwinGuardianPath: guardian,
    }).records(generation)?.every((record) => record.state === "owned") === true);
    deactivateFirst?.();
    const deactivateSecond = activateRuntimeOwnedProcessRegistry(secondRoot, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    try {
      // The replaced registry no longer owns a monitor capable of releasing
      // these guardians. Let their payloads finish, then prove the stopped
      // guardians and their durable claims remain fail-closed.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(children.every((child) => child.pid && exists(child.pid))).toBe(true);
      expect(new RuntimeOwnedProcessJournal(firstRoot, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toMatchObject([
        { state: "owned" },
        { state: "owned" },
      ]);
      expect(new RuntimeOwnedProcessJournal(secondRoot, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toEqual([]);
    } finally {
      await Promise.all(children.map(stopChild));
      deactivateSecond?.();
    }
  }, 15_000);

  linuxIt("enforces the exact preauth, claim, owned, and terminal protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-protocol-")); roots.push(root);
    const guardian = join(root, "guardian");
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
    ]);
    const executable = statSync(guardian, { bigint: true });
    const child = spawn(guardian, [
      "watch", String(process.pid), String(executable.dev), String(executable.ino), "--", "/bin/sleep", "1",
    ], {
      detached: true, stdio: "ignore",
    });
    const pid = child.pid!;
    const ready = execFileSync(guardian, ["ready", String(pid)], { encoding: "utf8" }).trim().split("|");
    const common = [
      "signal", String(pid), ready[3]!,
      String(executable.dev), String(executable.ino),
    ];
    expect(() => execFileSync(guardian, [...common, "exec"])).toThrow();
    const nested = [
      "const {spawnSync}=require('node:child_process');",
      `const r=spawnSync(${JSON.stringify(guardian)},${JSON.stringify([...common, "claim"])});`,
      "process.exit(r.status ?? 99);",
    ].join("");
    expect(() => execFileSync(process.execPath, ["-e", nested])).toThrow();
    expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("inertia-ready");
    execFileSync(guardian, [...common, "claim"]);
    expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("inertia-claim");
    expect(() => execFileSync(guardian, [...common, "claim"])).toThrow();
    execFileSync(guardian, [...common, "exec"]);
    expect(() => execFileSync(guardian, [...common, "exec"])).toThrow();
    await waitFor(() => {
      try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "inertia-exdone"; } catch { return false; }
    });
    process.kill(pid, "SIGCONT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("inertia-exdone");
    expect(readFileSync(`/proc/${pid}/status`, "utf8")).toContain("State:\tT");
    const untrustedRelease = [
      "const {spawnSync}=require('node:child_process');",
      `const r=spawnSync(${JSON.stringify(guardian)},${JSON.stringify([...common, "release"])});`,
      "process.exit(r.status ?? 99);",
    ].join("");
    expect(() => execFileSync(process.execPath, ["-e", untrustedRelease])).toThrow();
    expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("inertia-exdone");
    const release = spawn(guardian, [...common, "release"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      release.once("error", reject);
      release.once("close", (code) => code === 0
        ? resolve()
        : reject(new Error(`Release helper exited ${String(code)}.`)));
    });
    await waitFor(() => !exists(pid));
  }, 15_000);
});
