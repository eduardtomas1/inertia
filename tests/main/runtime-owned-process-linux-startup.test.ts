import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as linuxGuardian from "../../src/node/runtime-owned-process-linux";
import {
  awaitRuntimeOwnedProcessCleanupConfirmed,
  requestRuntimeOwnedGuardianStop,
  RuntimeOwnedProcessJournal,
  runtimeOwnedProcessInvocation,
  runtimeOwnedProcessOwnershipIsTainted,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const linuxIt = process.platform === "linux" ? it : it.skip;
afterEach(() => vi.restoreAllMocks());

linuxIt.each([false, true])("accepts exact terminal proof when stop races a delayed exec callback (released=%s)", async (released) => {
  const root = mkdtempSync(join(tmpdir(), "inertia-linux-startup-"));
  const guardian = join(process.cwd(), "resources/generated/runtime-process-guardian/runtime-process-guardian");
  const generation = "51000000-0000-4000-8000-000000000051:1";
  const onTainted = vi.fn();
  const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
    root, generation, "test:52000000-0000-4000-8000-000000000052",
    { platform: "linux", darwinGuardianPath: guardian, onTainted },
  );
  const signal = linuxGuardian.signalLinuxGuardianExactAsync;
  let child: ChildProcess | undefined;
  let stop: Promise<boolean> | null = null;
  let closed: Promise<void> | undefined;
  const monitor = linuxGuardian.monitorLinuxGuardianTerminal;
  let resumeMonitor = (): void => {};
  if (!released) vi.spyOn(linuxGuardian, "monitorLinuxGuardianTerminal").mockImplementation((...args) => {
    let stopMonitor = (): void => {};
    resumeMonitor = () => { stopMonitor = monitor(...args); };
    return () => stopMonitor();
  });
  vi.spyOn(linuxGuardian, "signalLinuxGuardianExactAsync").mockImplementation(async (...args) => {
    const result = await signal(...args);
    if (args[2] === "exec") {
      // Native completion is authoritative; hold only its JS delivery until
      // the short-lived payload and exact monitor have finished.
      if (released) await closed;
      else await expect.poll(() => linuxGuardian.linuxGuardianTerminalAuthority(
        args[0], guardian, "/proc", "inertia-exdone",
      )).toBe(true);
      stop = requestRuntimeOwnedGuardianStop(child!);
    }
    return result;
  });
  try {
    const invocation = runtimeOwnedProcessInvocation("/bin/true", []);
    child = spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args,
      { detached: true, stdio: "ignore" }));
    closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    await expect.poll(() => stop !== null).toBe(true);
    expect({ stopped: await Promise.resolve(stop), tainted: runtimeOwnedProcessOwnershipIsTainted(),
      diagnostics: onTainted.mock.calls }).toEqual({ stopped: true, tainted: false, diagnostics: [] });
    resumeMonitor();
    await closed;
    await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
    expect(new RuntimeOwnedProcessJournal(root).records(generation)).toEqual([]);
    expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
    expect(onTainted).not.toHaveBeenCalled();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    deactivate?.();
    rmSync(root, { recursive: true, force: true });
  }
});
