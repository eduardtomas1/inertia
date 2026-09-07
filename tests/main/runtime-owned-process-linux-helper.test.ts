import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { signalLinuxGuardianExactAsync } from "../../src/node/runtime-owned-process-linux";
import {
  runtimeOwnedProcessInvocation,
  runtimeOwnedProcessOwnershipIsTainted,
  spawnRuntimeOwnedPidProcess,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const linuxIt = process.platform === "linux" ? it : it.skip;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

linuxIt("does not taint a real guardian when ready-helper completions are scheduler-delayed", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-linux-helper-admission-"));
  const guardian = join(root, "guardian");
  childProcess.execFileSync("cc", [
    "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
  ]);
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const readyExits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const observedSpawn = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
    const helper = spawn(...args);
    if (Array.isArray(args[1]) && args[1][0] === "ready") {
      helper.once("close", (code, signal) => readyExits.push({ code, signal }));
      queueMicrotask(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_700);
      });
    }
    return helper;
  });
  const onTainted = vi.fn();
  const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
    root,
    "71000000-0000-4000-8000-000000000071:1",
    "test:72000000-0000-4000-8000-000000000072",
    { platform: "linux", darwinGuardianPath: guardian, onTainted },
  );
  let child: childProcess.ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  try {
    const invocation = runtimeOwnedProcessInvocation("/bin/true", []);
    const owned = spawnRuntimeOwnedPidProcess(() => {
      child = spawn(invocation.command, invocation.args, { detached: true, stdio: "ignore" });
      return { pid: child.pid! };
    }, { darwinGuardianCommand: invocation.command });
    closed = new Promise<void>((resolve) => child!.once("close", (_code, signal) => {
      owned.releaseIfGroupExited(signal ? 9 : undefined);
      resolve();
    }));
    const admitted = await owned.waitForGuardianStop();
    expect(readyExits.length).toBeGreaterThan(0);
    expect(readyExits.every(({ code, signal }) => code === 0 && signal === null)).toBe(true);
    expect({
      admitted,
      tainted: runtimeOwnedProcessOwnershipIsTainted(),
      restartRequests: onTainted.mock.calls.length,
    }).toEqual({ admitted: true, tainted: false, restartRequests: 0 });
    await closed;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    deactivate?.();
    observedSpawn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

async function runTransportHelper(
  source: string,
  beforeAwait: (abort: AbortController) => void = () => {},
  mode = 0o700,
) {
  const root = mkdtempSync(join(tmpdir(), "inertia-linux-helper-completion-"));
  const guardian = join(root, "guardian");
  writeFileSync(guardian, `#!/bin/sh\n${source}\n`, { mode });
  const executable = statSync(guardian, { bigint: true });
  const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const observedSpawn = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
    const child = spawn(...args);
    child.once("close", (code, signal) => exits.push({ code, signal }));
    return child;
  });
  try {
    const abort = new AbortController();
    const startedAt = Date.now();
    const completion = signalLinuxGuardianExactAsync({
      pid: 123, parentPid: process.pid, processGroupId: 123, startTimeTicks: "456",
      guardianExecutableDevice: String(executable.dev),
      guardianExecutableInode: String(executable.ino),
    }, guardian, "claim", abort.signal);
    beforeAwait(abort);
    const confirmed = await completion;
    return { confirmed, exits, elapsedMs: Date.now() - startedAt };
  } finally {
    observedSpawn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}

function stallEventLoop(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_700);
}

linuxIt("preserves a successful helper exit queued behind an event-loop stall", async () => {
  const result = await runTransportHelper("exit 0", stallEventLoop);
  expect(result.exits).toEqual([{ code: 0, signal: null }]);
  expect(result.confirmed).toBe(true);
});

linuxIt("still rejects an explicit abort when successful completion was already queued", async () => {
  const result = await runTransportHelper("exit 0", (abort) => {
    stallEventLoop();
    abort.abort();
  });
  expect(result.exits).toEqual([{ code: 0, signal: null }]);
  expect(result.confirmed).toBe(false);
});

linuxIt("still rejects excess output when successful completion was already queued", async () => {
  const result = await runTransportHelper("printf '%5000s' x", stallEventLoop);
  expect(result.exits).toEqual([{ code: 0, signal: null }]);
  expect(result.confirmed).toBe(false);
});

linuxIt("kills a genuinely unfinished helper at the unchanged deadline", async () => {
  const result = await runTransportHelper("exec /bin/sleep 10");
  expect(result.exits).toEqual([{ code: null, signal: "SIGKILL" }]);
  expect(result.confirmed).toBe(false);
  expect(result.elapsedMs).toBeLessThan(4_000);
});

linuxIt.each([
  { label: "nonzero exit", source: "exit 4", mode: 0o700 },
  { label: "unexpected stderr", source: "printf refused >&2", mode: 0o700 },
  { label: "spawn error", source: "exit 0", mode: 0o600 },
])("still rejects $label", async ({ source, mode }) => {
  const result = await runTransportHelper(source, undefined, mode);
  expect(result.confirmed).toBe(false);
});
