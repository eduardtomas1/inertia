// @inertia-test-suite portable
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createOwnedPidProcessTreeTermination,
  createOwnedProcessTreeTermination,
  terminateProcessTreeAndWait,
} from "../../src/server/process-lifecycle";
import { posixCleanupFailures } from "../../src/server/posix-cleanup-diagnostics";

function fakeChild(pid = 4_242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdio: Array<{ closed: boolean } | null>;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdio = [null, null, null];
  child.kill = vi.fn(() => true);
  return child;
}

function noSuchProcess(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ESRCH";
  return error;
}

describe("provider process-tree POSIX classification", () => {
  describe("terminal (PID-owned) tree with a delayed stop", () => {
    const pidTermination = (tablesByRead: (read: number) => string) => {
      const killed = new Set<number>();
      const killProcess = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0) {
          if (killed.has(target)) throw noSuchProcess("gone");
          return true as const;
        }
        if (signal === "SIGKILL") killed.add(target);
        return true as const;
      });
      let reads = 0;
      const spawnProcessSync = vi.fn(() => ({ status: 0, stdout: tablesByRead(++reads) }));
      const terminate = createOwnedPidProcessTreeTermination(
        4_242,
        async () => killed.has(4_242),
        {
          platform: "linux",
          killProcess: killProcess as never,
          spawnProcessSync: spawnProcessSync as never,
          processCanExecute: () => null,
          processGroupCanExecute: () => null,
          waitMs: 1_000,
        },
      );
      return { terminate, killProcess, spawnProcessSync };
    };

    it("confirms once the sent stop is observed on a later read", async () => {
      const { terminate, killProcess, spawnProcessSync } = pidTermination((read) =>
        read === 1 ? "4242 1 Ss+\n" : "4242 1 Ts+\n");
      await expect(terminate()).resolves.toBe(true);
      expect(spawnProcessSync).toHaveBeenCalledTimes(2);
      expect(killProcess.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [-4_242, "SIGSTOP"],
        [4_242, "SIGSTOP"],
        [-4_242, "SIGKILL"],
        [4_242, "SIGKILL"],
      ]);
    });

    it("reports its classification inputs when the stop is never observed", async () => {
      const { terminate } = pidTermination(() => "4242 1 Ss+\n");
      await expect(terminate()).resolves.toBe(false);
      expect(posixCleanupFailures().at(-1)).toEqual({
        scope: "pid",
        rootStop: "sent",
        rootState: "running",
        scanStabilized: false,
        groupExited: null,
        descendantsExited: null,
        rootExited: null,
      });
    });
  });

  describe("POSIX root classification (exhaustive)", () => {
    type Stop = "sent" | "ESRCH" | "EPERM" | "EINVAL";
    type Table = "running" | "stopped" | "zombie" | "absent" | "unknown";
    type Expected = "root-authorized" | "root-gone" | "incomplete";
    const expected: Record<Stop, Record<Table, [Expected, Expected]>> = {
      sent: {
        running: ["incomplete", "incomplete"],
        stopped: ["root-authorized", "incomplete"],
        zombie: ["root-gone", "root-gone"],
        absent: ["root-gone", "root-gone"],
        unknown: ["incomplete", "incomplete"],
      },
      ESRCH: {
        running: ["root-gone", "root-gone"],
        stopped: ["root-gone", "root-gone"],
        zombie: ["root-gone", "root-gone"],
        absent: ["root-gone", "root-gone"],
        unknown: ["root-gone", "root-gone"],
      },
      EPERM: {
        running: ["incomplete", "incomplete"],
        stopped: ["incomplete", "incomplete"],
        zombie: ["root-gone", "root-gone"],
        absent: ["root-gone", "root-gone"],
        unknown: ["incomplete", "incomplete"],
      },
      EINVAL: {
        running: ["incomplete", "incomplete"],
        stopped: ["incomplete", "incomplete"],
        zombie: ["root-gone", "root-gone"],
        absent: ["root-gone", "root-gone"],
        unknown: ["incomplete", "incomplete"],
      },
    };
    const rows = (Object.keys(expected) as Stop[]).flatMap((stop) =>
      (Object.keys(expected[stop]) as Table[]).flatMap((table) =>
        ([true, false] as const)
          .filter((stabilised) => table !== "unknown" || !stabilised)
          .map((stabilised) => ({
            stop, table, stabilised,
            classification: expected[stop][table][stabilised ? 0 : 1],
          }))));

    it.each(rows)("stop $stop, root $table, stabilised $stabilised: $classification", async ({
      stop, table, stabilised, classification,
    }) => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        const killed = new Set<number>();
        const killProcess = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
          if (target === 4_242 && signal === "SIGSTOP" && stop !== "sent") {
            const error = new Error(stop) as NodeJS.ErrnoException;
            error.code = stop;
            throw error;
          }
          if (signal === 0) {
            if (killed.has(target)) throw noSuchProcess("gone");
            return true as const;
          }
          if (signal === "SIGKILL") {
            killed.add(target);
            if (target === 4_242 && child.exitCode === null) {
              child.exitCode = 1;
              queueMicrotask(() => child.emit("close", 1));
            }
          }
          return true as const;
        });
        let next = 5_000;
        const spawnProcessSync = vi.fn(() => {
          if (table === "unknown") return { status: null, stdout: "" };
          const rootLine = table === "running" ? "4242 1 S"
            : table === "stopped" ? "4242 1 T"
              : table === "zombie" ? "4242 1 Z" : "";
          const children = stabilised ? ["5000 4242 T"] : [`${next++} 4242 S`];
          return { status: 0, stdout: `${[rootLine, ...children].filter(Boolean).join("\n")}\n` };
        });
        let result: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, true, {
          platform: "linux",
          killProcess: killProcess as never,
          spawnProcessSync: spawnProcessSync as never,
          processCanExecute: () => null,
          processGroupCanExecute: () => null,
          waitMs: 1_000,
        }).then((value) => { result = value; });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(killProcess.mock.calls.slice(0, 2)).toEqual([[-4_242, "SIGSTOP"], [4_242, "SIGSTOP"]]);
        expect(result).toBe(classification !== "incomplete");
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      { later: "4242 1 T", classification: "root-authorized" },
      { later: "4242 1 Z", classification: "root-gone" },
      { later: "", classification: "root-gone" },
    ])("stop sent but first observed running, then $later: $classification", async ({ later, classification }) => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        const killed = new Set<number>();
        const killProcess = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
          if (signal === 0) {
            if (killed.has(target)) throw noSuchProcess("gone");
            return true as const;
          }
          if (signal === "SIGKILL") {
            killed.add(target);
            if (target === 4_242 && child.exitCode === null) {
              child.exitCode = 1;
              queueMicrotask(() => child.emit("close", 1));
            }
          }
          return true as const;
        });
        let reads = 0;
        const spawnProcessSync = vi.fn(() => {
          reads += 1;
          const root = reads === 1 ? "4242 1 S" : later;
          return { status: 0, stdout: `${[root, "5000 4242 T"].filter(Boolean).join("\n")}\n` };
        });
        let result: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, true, {
          platform: "linux",
          killProcess: killProcess as never,
          spawnProcessSync: spawnProcessSync as never,
          processCanExecute: () => null,
          processGroupCanExecute: () => null,
          waitMs: 1_000,
        }).then((value) => { result = value; });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(result).toBe(classification !== "incomplete");
        expect(spawnProcessSync.mock.calls.length).toBeGreaterThan(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never confirms a live root that refused both stops even after the scan stabilised and the root later exited", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        const killed = new Set<number>();
        const denied = (): never => {
          const error = new Error("EPERM") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        };
        const killProcess = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
          if (target === 4_242 && signal !== 0) denied();
          if (signal === 0) {
            if (killed.has(target)) throw noSuchProcess("gone");
            return true as const;
          }
          if (signal === "SIGKILL") killed.add(target);
          return true as const;
        });
        setTimeout(() => {
          child.exitCode = 0;
          child.emit("close", 0);
        }, 50);
        let result: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, true, {
          platform: "linux",
          killProcess: killProcess as never,
          spawnProcessSync: vi.fn(() => ({ status: 0, stdout: "4242 1 S\n5000 4242 T\n" })) as never,
          processCanExecute: () => null,
          processGroupCanExecute: () => null,
          waitMs: 1_000,
        }).then((value) => { result = value; });
        await vi.advanceTimersByTimeAsync(100);
        expect(killProcess.mock.calls.filter(([, signal]) => signal !== 0).slice(0, 8)).toEqual([
          [-4_242, "SIGSTOP"],
          [4_242, "SIGSTOP"],
          [-5_000, "SIGSTOP"],
          [5_000, "SIGSTOP"],
          [-5_000, "SIGKILL"],
          [5_000, "SIGKILL"],
          [-4_242, "SIGKILL"],
          [4_242, "SIGKILL"],
        ]);
        expect(result).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("classifies a root whose exit Node observed before cleanup as gone without signalling it", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.exitCode = 0;
        child.stdio[1] = { closed: false };
        const killProcess = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
          if (signal === 0 && target === -4_242) throw noSuchProcess("gone");
          return true as const;
        });
        let result: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, true, {
          platform: "linux",
          killProcess: killProcess as never,
          spawnProcessSync: vi.fn(() => ({ status: 0, stdout: "" })) as never,
          processCanExecute: () => null,
          processGroupCanExecute: () => null,
          waitMs: 1_000,
        }).then((value) => { result = value; });
        child.stdio[1] = { closed: true };
        child.emit("close", 0);
        await vi.advanceTimersByTimeAsync(10);
        expect(result).toBe(true);
        expect(killProcess.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("POSIX tree termination truth table", () => {
    interface Row {
      label: string;
      force: boolean;
      rootExitObserved: boolean;
      rootAtStop: "alive" | "gone" | "zombie";
      descendant: "none" | "exits" | "survives";
      groupExits: boolean;
      closeArrives: boolean;
      confirmed: boolean;
    }
    const rows: Row[] = [
      { label: "a frozen live root whose whole tree exits", force: true, rootExitObserved: false, rootAtStop: "alive", descendant: "exits", groupExits: true, closeArrives: true, confirmed: true },
      { label: "a frozen live root whose known descendant survives", force: true, rootExitObserved: false, rootAtStop: "alive", descendant: "survives", groupExits: true, closeArrives: true, confirmed: false },
      { label: "a frozen live root whose group survives", force: true, rootExitObserved: false, rootAtStop: "alive", descendant: "none", groupExits: false, closeArrives: true, confirmed: false },
      { label: "a frozen live root whose close never arrives", force: true, rootExitObserved: false, rootAtStop: "alive", descendant: "none", groupExits: true, closeArrives: false, confirmed: false },
      { label: "a root that exits before the stop and whose exit Node observes in time", force: true, rootExitObserved: false, rootAtStop: "gone", descendant: "none", groupExits: true, closeArrives: true, confirmed: true },
      { label: "a root that exits before the stop and whose exit Node never observes", force: true, rootExitObserved: false, rootAtStop: "gone", descendant: "none", groupExits: true, closeArrives: false, confirmed: false },
      { label: "a root that exits before the stop and leaves a group member running", force: true, rootExitObserved: false, rootAtStop: "gone", descendant: "none", groupExits: false, closeArrives: true, confirmed: false },
      { label: "a zombie root that Node reaps in time", force: true, rootExitObserved: false, rootAtStop: "zombie", descendant: "none", groupExits: true, closeArrives: true, confirmed: true },
      { label: "a normal exit Node observed before cleanup", force: true, rootExitObserved: true, rootAtStop: "gone", descendant: "none", groupExits: true, closeArrives: true, confirmed: true },
      { label: "a normal exit that left a group member running", force: true, rootExitObserved: true, rootAtStop: "gone", descendant: "none", groupExits: false, closeArrives: true, confirmed: false },
      { label: "a graceful stop whose root and group exit", force: false, rootExitObserved: false, rootAtStop: "alive", descendant: "none", groupExits: true, closeArrives: true, confirmed: true },
      { label: "a graceful stop whose group survives", force: false, rootExitObserved: false, rootAtStop: "alive", descendant: "none", groupExits: false, closeArrives: true, confirmed: false },
      { label: "a graceful stop after a normal exit", force: false, rootExitObserved: true, rootAtStop: "gone", descendant: "none", groupExits: true, closeArrives: true, confirmed: true },
    ];

    const tree = (row: Row) => {
      const child = fakeChild();
      if (row.rootExitObserved) {
        child.exitCode = 0;
        child.stdio[1] = { closed: false };
      }
      const exited = new Set<number>();
      if (row.rootAtStop !== "alive") exited.add(4_242);
      if (row.rootExitObserved && row.groupExits) exited.add(-4_242);
      let closing = false;
      const close = (): void => {
        if (!row.closeArrives || closing) return;
        closing = true;
        child.exitCode ??= 1;
        child.stdio[1] = { closed: true };
        queueMicrotask(() => child.emit("close", child.exitCode));
      };
      if (row.rootExitObserved) setTimeout(close, 5);
      const killProcess = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
        if (exited.has(target)) throw noSuchProcess("gone");
        if (signal === "SIGKILL" || signal === "SIGTERM") {
          if (target === -4_242 && row.groupExits) exited.add(-4_242);
          if (target === 4_242 && row.rootAtStop === "alive") exited.add(4_242);
          if (target === 5_000 && row.descendant === "exits") exited.add(5_000);
          if (target === -4_242 || target === 4_242) close();
        }
        return true as const;
      });
      const rootLine = row.rootAtStop === "alive" ? "4242 1 T"
        : row.rootAtStop === "zombie" ? "4242 1 Z" : "";
      const descendantLine = row.descendant === "none" || row.rootAtStop !== "alive"
        ? "" : "5000 4242 S";
      const listing = [rootLine, descendantLine].filter(Boolean).join("\n");
      return {
        child,
        killProcess,
        spawnProcessSync: vi.fn(() => ({ status: 0, stdout: `${listing}\n` })),
      };
    };

    it.each(rows)("reports $confirmed for $label", async (row) => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const { child, killProcess, spawnProcessSync } = tree(row);
        let result: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, row.force, {
          platform: "linux",
          killProcess: killProcess as never,
          spawnProcessSync: spawnProcessSync as never,
          processCanExecute: () => null,
          processGroupCanExecute: () => null,
          waitMs: 100,
        }).then((value) => { result = value; });
        await vi.advanceTimersByTimeAsync(row.confirmed ? 20 : 101);
        expect(result).toBe(row.confirmed);
        expect(Date.now() - startedAt).toBeLessThanOrEqual(101);
      } finally {
        vi.useRealTimers();
      }
    });

    it("confirms a normal exit through the owned termination without escalating or waiting out the budget", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const row = rows.find(({ label }) => label === "a graceful stop after a normal exit")!;
        const { child, killProcess, spawnProcessSync } = tree(row);
        const terminateProcessTree = vi.fn((ownedChild: ChildProcess, force: boolean) =>
          terminateProcessTreeAndWait(ownedChild, force, {
            platform: "linux",
            killProcess: killProcess as never,
            spawnProcessSync: spawnProcessSync as never,
            processCanExecute: () => null,
            processGroupCanExecute: () => null,
            waitMs: 100,
          }));
        let settled = false;
        void createOwnedProcessTreeTermination(
          child as never,
          "Provider process tree",
          terminateProcessTree,
        )(false).then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(5);
        expect(settled).toBe(true);
        expect(terminateProcessTree).toHaveBeenCalledOnce();
        expect(spawnProcessSync).not.toHaveBeenCalled();
        expect(Date.now() - startedAt).toBe(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      { closeArrives: true, confirmed: "confirmed" },
      { closeArrives: false, confirmed: "unconfirmed" },
    ])("reports $confirmed for a cancellation whose forced call meets a vanished root (close arrives: $closeArrives)", async ({ closeArrives, confirmed }) => {
      vi.useFakeTimers();
      try {
        const row = { ...rows.find(({ label }) => label.startsWith("a root that exits before the stop and whose exit Node observes"))!, closeArrives };
        const { child, killProcess, spawnProcessSync } = tree(row);
        const outcome = createOwnedProcessTreeTermination(
          child as never,
          "Provider process tree",
          (ownedChild, force) => terminateProcessTreeAndWait(ownedChild, force, {
            platform: "linux",
            killProcess: killProcess as never,
            spawnProcessSync: spawnProcessSync as never,
            processCanExecute: () => null,
            processGroupCanExecute: () => null,
            waitMs: 100,
          }),
        )(true).then(() => "confirmed", (error: unknown) =>
          (error as { code?: string }).code === "process-tree-termination-unconfirmed"
            ? "unconfirmed" : error);
        await vi.advanceTimersByTimeAsync(101);
        await expect(outcome).resolves.toBe(confirmed);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
