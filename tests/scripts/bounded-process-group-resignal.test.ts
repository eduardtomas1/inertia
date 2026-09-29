import { afterEach, describe, expect, it, vi } from "vitest";

import { terminatePosixProcessGroup } from "../../scripts/bounded-process-tree.mjs";

const processGroupId = 424_242;

function noSuchProcess(): NodeJS.ErrnoException {
  const error = new Error("gone") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  return error;
}

function groupThatNeedsKills(killsNeeded: number) {
  let kills = 0;
  return vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
    if (pid !== -processGroupId) throw new Error("unexpected target");
    if (signal === "SIGKILL") kills += 1;
    if (kills >= killsNeeded) throw noSuchProcess();
    return true;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded runner POSIX group termination", () => {
  it.skipIf(process.platform === "win32")("re-signals the group on each settle probe while its leader is unreaped", async () => {
    vi.useFakeTimers();
    const kill = groupThatNeedsKills(3);
    const stopped = terminatePosixProcessGroup(processGroupId, {
      resignalWhile: () => true,
      groupExists: () => true,
      groupCanExecute: () => null,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(stopped).resolves.toBe(true);
    expect(kill.mock.calls).toEqual([
      [-processGroupId, "SIGKILL"],
      [-processGroupId, "SIGKILL"],
      [-processGroupId, "SIGKILL"],
    ]);
  });

  it.skipIf(process.platform === "win32")("only probes the group once its leader has been reaped, even while that group number stays live", async () => {
    vi.useFakeTimers();
    const kill = groupThatNeedsKills(Number.POSITIVE_INFINITY);
    const stopped = terminatePosixProcessGroup(processGroupId, {
      resignalWhile: () => false,
      groupExists: () => true,
      groupCanExecute: () => null,
      timeoutMs: 300,
    });
    await vi.advanceTimersByTimeAsync(300);
    await expect(stopped).resolves.toBe(false);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [-processGroupId, "SIGKILL"],
    ]);
  });

  it.skipIf(process.platform === "win32")("stops re-signalling as soon as the leader is reaped mid-wait", async () => {
    vi.useFakeTimers();
    const kill = groupThatNeedsKills(Number.POSITIVE_INFINITY);
    let leaderUnreaped = true;
    const stopped = terminatePosixProcessGroup(processGroupId, {
      resignalWhile: () => leaderUnreaped,
      groupExists: () => true,
      groupCanExecute: () => null,
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(150);
    leaderUnreaped = false;
    await vi.advanceTimersByTimeAsync(350);
    await expect(stopped).resolves.toBe(false);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [-processGroupId, "SIGKILL"],
      [-processGroupId, "SIGKILL"],
      [-processGroupId, "SIGKILL"],
    ]);
  });
});
