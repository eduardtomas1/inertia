import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as linuxGuardian from "../../src/node/runtime-owned-process-linux";
import {
  awaitRuntimeOwnedProcessCleanupConfirmed,
  runtimeOwnedProcessInvocation,
  runtimeOwnedProcessOwnershipIsTainted,
  spawnRuntimeOwnedPidProcess,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const linuxIt = process.platform === "linux" ? it : it.skip;
afterEach(() => vi.restoreAllMocks());

linuxIt.each(["exec", "stop"] as const)(
  "requires exact post-exec authority when observations miss and the monitor is delayed: %s",
  async (action) => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-admission-"));
    const guardian = join(root, "guardian");
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
    ]);
    const monitor = linuxGuardian.monitorLinuxGuardianTerminal;
    const signal = linuxGuardian.signalLinuxGuardianExactAsync;
    const terminalAuthority = linuxGuardian.linuxGuardianTerminalAuthority;
    let resumeMonitor = (): void => {};
    vi.spyOn(linuxGuardian, "monitorLinuxGuardianTerminal").mockImplementation((...args) => {
      let stop = (): void => {};
      resumeMonitor = () => { stop = monitor(...args); };
      return () => stop();
    });
    vi.spyOn(linuxGuardian, "signalLinuxGuardianExactAsync").mockImplementation(async (...args) => {
      if (args[2] !== "exec") return signal(...args);
      await signal(args[0], args[1], action, args[3]);
      await expect.poll(() => terminalAuthority(
        args[0], args[1], "/proc", action === "exec" ? "inertia-exdone" : "inertia-done",
      )).toBe(true);
      return false;
    });
    vi.spyOn(linuxGuardian, "readLinuxGuardianOwnedAsync").mockResolvedValue(null);
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      root,
      "41000000-0000-4000-8000-000000000041:1",
      "test:42000000-0000-4000-8000-000000000042",
      { platform: "linux", darwinGuardianPath: guardian },
    );
    let child: ChildProcess | undefined;
    try {
      const invocation = runtimeOwnedProcessInvocation("/bin/true", []);
      const owned = spawnRuntimeOwnedPidProcess(() => {
        child = spawn(invocation.command, invocation.args, { detached: true, stdio: "ignore" });
        return { pid: child.pid! };
      }, { darwinGuardianCommand: invocation.command });
      const closed = new Promise<void>((resolve) => child!.once("close", (_code, exitSignal) => {
        owned.releaseIfGroupExited(exitSignal ? 9 : undefined);
        resolve();
      }));
      await expect(owned.waitForGuardianStop()).resolves.toBe(action === "exec");
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(action !== "exec");
      expect(owned.confirmStopped()).toBe(false);
      resumeMonitor();
      await closed;
      await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
      expect(owned.confirmStopped()).toBe(true);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
        child.kill("SIGKILL");
        await closed;
      }
      deactivate?.();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
