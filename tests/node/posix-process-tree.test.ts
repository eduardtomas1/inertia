import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { forceKillPosixProcessTreeWithStatus, procProcessTable } from "../../src/node/posix-process-tree";

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
      [-4_242, "SIGSTOP"],
      [4_242, "SIGSTOP"],
      [-4_242, "SIGSTOP"],
      [4_242, "SIGSTOP"],
      [-4_242, "SIGKILL"],
      [4_242, "SIGKILL"],
    ]);
  });

  it("re-sends the stop when the first one was discarded before it took effect", () => {
    let rootStops = 0;
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4_242 && signal === "SIGSTOP") rootStops += 1;
      return true;
    });
    const spawnProcessSync = vi.fn(() => ({
      status: 0,
      stdout: rootStops >= 2 ? "4242 1 Ts+\n" : "4242 1 Ss+\n",
    }));
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: kill as never,
      spawnProcessSync: spawnProcessSync as never,
      rootProcessGroup: true,
    });
    expect(result).toMatchObject({
      rootStop: "sent",
      rootState: "stopped",
      scanStabilized: true,
      snapshotConfirmed: true,
    });
    expect(rootStops).toBe(2);
    expect(spawnProcessSync).toHaveBeenCalledTimes(2);
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
    const pause = vi.fn();
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: spawnProcessSync as never,
      rootProcessGroup: true,
      pause,
    });
    expect(result).toMatchObject({
      rootStop: "sent",
      rootState: "running",
      scanStabilized: false,
    });
    expect(spawnProcessSync).toHaveBeenCalledTimes(9);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
  });

  it("confirms a root that acts on its stop only after nine back-to-back reads", () => {
    let clock = 0;
    const spawnProcessSync = vi.fn(() => {
      clock += 2;
      return { status: 0, stdout: clock >= 100 ? "4242 1 Tl\n" : "4242 1 Rl\n" };
    });
    const pause = vi.fn((ms: number) => { clock += ms; });
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: spawnProcessSync as never,
      rootProcessGroup: true,
      deadlineAt: 2_000,
      now: () => clock,
      pause,
    });
    expect(result).toMatchObject({
      rootStop: "sent",
      rootState: "stopped",
      rootRunningObserved: true,
      scanStabilized: true,
      snapshotConfirmed: true,
    });
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(spawnProcessSync).toHaveBeenCalledTimes(8);
  });

  it("pauses between stop observations only within the deadline", () => {
    let clock = 0;
    const spawnProcessSync = vi.fn(() => {
      clock += 2;
      return { status: 0, stdout: "4242 1 R\n" };
    });
    const pause = vi.fn((ms: number) => { clock += ms; });
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: spawnProcessSync as never,
      deadlineAt: 40,
      now: () => clock,
      pause,
    });
    expect(result).toMatchObject({ rootState: "running", scanStabilized: false });
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1, 2, 4, 8, 15]);
    expect(clock).toBe(40);
  });

  it.each([
    ["empty", ""],
    ["truncated", "1 0 Ss\n"],
  ])("never takes a timed-out read that exited 0 with %s output as the process table", (_name, stdout) => {
    const reads = [
      { status: 0, signal: null, stdout, error: error("ETIMEDOUT") },
      { status: 0, signal: null, stdout: "4242 1 Ts\n5000 4242 Ss\n" },
      { status: 0, signal: null, stdout: "4242 1 Ts\n5000 4242 Ts\n" },
    ];
    const spawnProcessSync = vi.fn(() => reads.shift() ?? reads.at(-1));
    const kill = vi.fn(() => true);
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: kill as never,
      spawnProcessSync: spawnProcessSync as never,
      rootProcessGroup: true,
    });
    expect(result).toMatchObject({
      rootStop: "sent",
      rootState: "stopped",
      rootRunningObserved: false,
      snapshotConfirmed: true,
      snapshotReads: 3,
      snapshotTimeouts: 1,
      descendants: [5_000],
    });
    expect(kill).toHaveBeenCalledWith(5_000, "SIGKILL");
  });

  it.each([
    ["ENOBUFS", { status: 0, signal: null, stdout: "4242 1 Ts\n", error: error("ENOBUFS") }],
    ["ENOENT", { status: null, signal: null, stdout: undefined, error: error("ENOENT") }],
    ["EAGAIN", { status: null, signal: null, stdout: "", error: error("EAGAIN") }],
  ])("never takes a read that failed with %s as the process table", (_code, read) => {
    const result = forceKillPosixProcessTreeWithStatus(4_242, {
      kill: vi.fn(() => true) as never,
      spawnProcessSync: vi.fn(() => read) as never,
      rootProcessGroup: true,
      platform: "linux",
      procRoot: join(tmpdir(), `inertia-missing-proc-${process.pid}`),
    });
    expect(result).toMatchObject({
      rootStop: "sent",
      rootState: "unknown",
      snapshotConfirmed: false,
      scanStabilized: false,
      snapshotReads: 8,
      snapshotTimeouts: 0,
      descendants: [],
    });
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

describe("POSIX process table without ps", () => {
  it("reads the Linux process table from procfs when ps is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-proc-"));
    try {
      const stats: Array<[number, string]> = [
        [1, "1 (systemd) S 0 1 1 0 -1 4194560"],
        [4242, "4242 (node) S 1 4242 4242 0 -1 4194560"],
        [4300, "4300 (sh (dash)) T 4242 4242 4242 0 -1 4194304"],
        [4301, "4301 (sleep) R 4300 4242 4242 0 -1 4194304"],
      ];
      for (const [pid, stat] of stats) {
        mkdirSync(join(root, String(pid)));
        writeFileSync(join(root, String(pid), "stat"), `${stat}\n`);
      }
      writeFileSync(join(root, "uptime"), "12.34 45.67\n");
      mkdirSync(join(root, "self"));
      expect(procProcessTable(root)!.trim().split("\n").sort()).toEqual([
        "1 0 S",
        "4242 1 S",
        "4300 4242 T",
        "4301 4300 R",
      ]);

      const kill = vi.fn();
      const spawnProcessSync = vi.fn(() => ({ status: null, stdout: "", error: error("ENOENT") }));
      const result = forceKillPosixProcessTreeWithStatus(4242, {
        kill: kill as never,
        spawnProcessSync: spawnProcessSync as never,
        platform: "linux",
        procRoot: root,
        pause: () => undefined,
      });
      expect(spawnProcessSync).toHaveBeenCalled();
      expect(result.descendants).toEqual([4301, 4300]);
      expect(result.rootRunningObserved).toBe(true);
      expect(kill).toHaveBeenCalledWith(4301, "SIGKILL");
      expect(kill).toHaveBeenCalledWith(4300, "SIGKILL");
      expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays unconfirmed off Linux when ps is missing", () => {
    const result = forceKillPosixProcessTreeWithStatus(4242, {
      kill: vi.fn() as never,
      spawnProcessSync: vi.fn(() => ({ status: null, stdout: "", error: error("ENOENT") })) as never,
      platform: "darwin",
      pause: () => undefined,
    });
    expect(result.snapshotConfirmed).toBe(false);
    expect(result.descendants).toEqual([]);
  });
});
