import { describe, expect, it, vi } from "vitest";

import { forceKillPosixProcessTreeWithStatus } from "../../src/node/posix-process-tree";

function error(code: string): NodeJS.ErrnoException {
  const failure = new Error(code) as NodeJS.ErrnoException;
  failure.code = code;
  return failure;
}

function tables(...stdouts: Array<string | null>) {
  const queue = [...stdouts];
  return vi.fn(() => {
    const stdout = queue.length > 1 ? queue.shift()! : queue[0]!;
    return stdout === null ? { status: null, stdout: "" } : { status: 0, stdout };
  });
}

describe("POSIX process tree root observation", () => {
  it("re-reads the table until a sent stop is observed and then confirms the snapshot", () => {
    const spawnProcessSync = tables("4242 1 Ss\n", "4242 1 Ss\n", "4242 1 Ts\n");
    const kill = vi.fn(() => true);
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: kill as never,
      spawnProcessSync: spawnProcessSync as never,
      rootProcessGroup: true,
    });
    expect(result).toMatchObject({
      rootStop: "sent",
      rootState: "stopped",
      rootRunningObserved: true,
      scanStabilized: true,
      snapshotConfirmed: true,
    });
    expect(spawnProcessSync).toHaveBeenCalledTimes(3);
    expect(kill.mock.calls).toEqual([
      [-4_242, "SIGSTOP"],
      [4_242, "SIGSTOP"],
      [-4_242, "SIGKILL"],
      [4_242, "SIGKILL"],
    ]);
  });

  it("remembers a running observation after the root later disappears", () => {
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: tables("4242 1 Ss\n", "1 0 Ss\n") as never,
      rootProcessGroup: true,
    });
    expect(result).toMatchObject({
      rootStop: "sent",
      rootState: "absent",
      rootRunningObserved: true,
      snapshotConfirmed: false,
    });
  });

  it("does not report a running observation when the first read already shows the stop", () => {
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: tables("4242 1 Ts\n") as never,
      rootProcessGroup: true,
    });
    expect(result).toMatchObject({
      rootState: "stopped",
      rootRunningObserved: false,
      snapshotConfirmed: true,
    });
  });

  it("stays unconfirmed when a sent stop is never observed within the bounded re-reads", () => {
    const spawnProcessSync = tables("4242 1 R+\n");
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: spawnProcessSync as never,
      rootProcessGroup: true,
    });
    expect(result).toMatchObject({
      rootStop: "sent",
      rootState: "running",
      scanStabilized: false,
    });
    expect(spawnProcessSync).toHaveBeenCalledTimes(9);
  });

  it("stops re-reading at the deadline", () => {
    let clock = 0;
    const spawnProcessSync = vi.fn(() => {
      clock += 40;
      return { status: 0, stdout: "4242 1 S\n" };
    });
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: spawnProcessSync as never,
      deadlineAt: 100,
      now: () => clock,
    });
    expect(result.scanStabilized).toBe(false);
    expect(spawnProcessSync).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["Ts", "stopped"],
    ["T+", "stopped"],
    ["TN", "stopped"],
    ["Ts+", "stopped"],
    ["t", "stopped"],
    ["tl", "stopped"],
    ["Ss+", "running"],
    ["S", "running"],
    ["R+", "running"],
    ["Rs", "running"],
    ["D", "running"],
    ["I", "running"],
    ["U", "running"],
    ["Z", "zombie"],
    ["Z+", "zombie"],
    ["X", "absent"],
  ])("maps process STAT %s to %s", (stat, state) => {
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn((pid: number) => {
        if (pid === 4_242) throw error("EPERM");
        return true;
      }) as never,
      spawnProcessSync: tables(`4242 1 ${stat}\n`) as never,
    });
    expect(result.rootStop).toBe("denied");
    expect(result.rootState).toBe(state);
  });

  it("reports a root missing from the table as absent", () => {
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: tables("1 0 Ss\n") as never,
    });
    expect(result.rootState).toBe("absent");
    expect(result.scanStabilized).toBe(true);
  });
});
