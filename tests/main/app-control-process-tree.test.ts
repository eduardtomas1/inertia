import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  APP_CONTROL_MAX_TREE_PROCESSES,
  appControlOwnedTree,
  appControlStartMatches,
  AppControlTreeTooLargeError,
  parseLinuxBootTime,
  parseLinuxStat,
  readLinuxProcessTable,
  type AppControlProcessEntry,
} from "../../src/main/app-control-process-tree";
import {
  MacProcessFacts,
  parseBsdInfo,
  parsePidList,
  parsePidPath,
  PROC_BSDINFO_BYTES,
} from "../../src/main/app-control-macos-process";
import {
  filetimeToEpochMs,
  integrityRidFromTokenLabel,
  parseProcessEntry,
  PROCESS_ENTRY_BYTES,
  uipiBlocks,
  windowsTreeWithStartTimes,
  WINDOWS_INTEGRITY,
} from "../../src/main/app-control-windows";

const started = 1_760_000_000_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entry(pid: number, parentPid: number, startedAtMs: number | null = started + 100, executable: string | null = "/opt/app/bin/app"): AppControlProcessEntry {
  return { pid, parentPid, startedAtMs, executable };
}

describe("App control process tree", () => {
  it("scopes to the launch root and its live descendants", () => {
    const tree = appControlOwnedTree([
      entry(1, 0, 0),
      entry(100, 1),
      entry(101, 100, started + 200, "/usr/bin/guardian"),
      entry(102, 101, started + 300, "/home/dev/app/bin/app"),
      entry(103, 102, started + 400, "/usr/bin/gnome-keyring-daemon"),
      entry(200, 1, started + 100, "/usr/bin/other"),
      entry(201, 200),
    ], 100, started);
    expect(tree).toEqual({ pids: [100, 101, 102, 103], deniedPids: [103] });
  });

  it("refuses a root whose start time does not match the launch (pid reuse) or that is gone", () => {
    const table = [entry(100, 1, started + 60_000), entry(101, 100)];
    expect(appControlOwnedTree(table, 100, started)).toBeNull();
    expect(appControlOwnedTree([entry(100, 1, started - 10_000)], 100, started)).toBeNull();
    expect(appControlOwnedTree([entry(5, 1)], 100, started)).toBeNull();
    // An unknown start time cannot prove the identity: the launch is gone.
    expect(appControlOwnedTree([entry(100, 1, null)], 100, started)).toBeNull();
    expect(appControlStartMatches(null, started)).toBe(false);
    expect(appControlStartMatches(started - 1_500, started)).toBe(true);
    expect(appControlStartMatches(started + 14_000, started)).toBe(true);
    expect(appControlStartMatches(started + 16_000, started)).toBe(false);
  });

  it("drops a child that started before the root, a reused pid", () => {
    const tree = appControlOwnedTree([entry(100, 1, started), entry(101, 100, started - 60_000)], 100, started);
    expect(tree).toEqual({ pids: [100], deniedPids: [] });
  });

  it("checks every child against its direct parent and fails closed on an unknown start time", () => {
    const now = started + 50;
    // The reviewer's probe: a child with no start time is dropped.
    expect(appControlOwnedTree([
      { pid: 400, parentPid: 4, startedAtMs: now, executable: "C:\\app\\app.exe" },
      { pid: 900, parentPid: 400, startedAtMs: null, executable: "C:\\app\\child.exe" },
    ], 400, started)).toEqual({ pids: [400], deniedPids: [] });
    // A grandchild older than its own parent (though younger than the root) is a reused pid; so is its subtree.
    expect(appControlOwnedTree([
      entry(100, 1, started),
      entry(101, 100, started + 1_000),
      entry(102, 101, started + 500),
      entry(103, 102, started + 2_000),
      entry(104, 101, started + 1_000),
      entry(105, 104, null),
      entry(106, 105, started + 3_000),
    ], 100, started)).toEqual({ pids: [100, 101, 104], deniedPids: [] });
  });

  it("treats an in-tree executable that could not be read as denied", () => {
    expect(appControlOwnedTree([entry(100, 1, started), entry(101, 100, started + 10, null)], 100, started))
      .toEqual({ pids: [100, 101], deniedPids: [101] });
  });

  it("refuses a tree larger than it checks instead of reading part of it", () => {
    const table = [entry(100, 1, started), ...Array.from({ length: APP_CONTROL_MAX_TREE_PROCESSES }, (_, index) => entry(1_000 + index, 100, started + 1))];
    expect(appControlOwnedTree(table, 100, started)).toBe("too-large");
    expect(appControlOwnedTree(table.slice(0, APP_CONTROL_MAX_TREE_PROCESSES), 100, started)).toMatchObject({ deniedPids: [] });
  });

  // Linux-only reader; Windows resolves the fake /proc exe symlinks to drive paths.
  it.skipIf(process.platform === "win32")("reads the Linux process table from proc without spawning anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-app-control-proc-"));
    roots.push(root);
    writeFileSync(join(root, "stat"), "cpu 1 2 3\nbtime 1760000000\n");
    for (const [pid, parent, ticks] of [[100, 1, 50], [101, 100, 70], [200, 1, 10]] as const) {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), "stat"), `${pid} (my app (x)) S ${parent} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`);
    }
    symlinkSync("/usr/bin/true", join(root, "101", "exe"));
    symlinkSync("/usr/bin/false", join(root, "200", "exe"));
    mkdirSync(join(root, "self"));
    const table = await readLinuxProcessTable(100, root);
    expect(table.sort((left, right) => left.pid - right.pid)).toEqual([
      { pid: 100, parentPid: 1, startedAtMs: 1_760_000_000_500, executable: null },
      { pid: 101, parentPid: 100, startedAtMs: 1_760_000_000_700, executable: "/usr/bin/true" },
      // Executables outside the launch's tree are never read.
      { pid: 200, parentPid: 1, startedAtMs: 1_760_000_000_100, executable: null },
    ]);
    // The root's executable could not be read: it is denied, never skipped.
    expect(appControlOwnedTree(table, 100, 1_760_000_000_500)).toEqual({ pids: [100, 101], deniedPids: [100] });
    expect(parseLinuxStat("1 (a) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 9 0")).toEqual({ parentPid: 0, startTicks: 9 });
    expect(parseLinuxStat("garbage")).toBeNull();
    expect(parseLinuxBootTime("btime 12\n")).toBe(12_000);
  });
});

describe("Linux process table bounds", () => {
  it("refuses a launch tree of more than 1,024 processes instead of skipping executable reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-app-control-proc-"));
    roots.push(root);
    writeFileSync(join(root, "stat"), "btime 1760000000\n");
    for (let index = 0; index <= APP_CONTROL_MAX_TREE_PROCESSES + 1; index += 1) {
      const pid = 100 + index;
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), "stat"), `${pid} (app) S ${index === 0 ? 1 : 100} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 50 0 0`);
    }
    await expect(readLinuxProcessTable(100, root)).rejects.toBeInstanceOf(AppControlTreeTooLargeError);
  });
});

describe("Windows process facts", () => {
  it("parses a PROCESSENTRY32W record", () => {
    const record = Buffer.alloc(PROCESS_ENTRY_BYTES);
    record.writeUInt32LE(PROCESS_ENTRY_BYTES, 0);
    record.writeUInt32LE(4_321, 8);
    record.writeUInt32LE(1_234, 32);
    record.write("MyApp.exe\u0000junk", 44, "utf16le");
    expect(parseProcessEntry(record)).toEqual({ pid: 4_321, parentPid: 1_234, executable: "MyApp.exe" });
    expect(parseProcessEntry(Buffer.alloc(10))).toBeNull();
  });

  it("reads a start time for every candidate in the launch's tree, and none outside it", () => {
    const asked: number[] = [];
    const table = [
      { pid: 4, parentPid: 0, startedAtMs: null, executable: "System" },
      { pid: 400, parentPid: 4, startedAtMs: null, executable: "app.exe" },
      { pid: 401, parentPid: 400, startedAtMs: null, executable: "helper.exe" },
      { pid: 402, parentPid: 401, startedAtMs: null, executable: "gone.exe" },
      { pid: 900, parentPid: 4, startedAtMs: null, executable: "other.exe" },
    ];
    const times: Record<number, number | null> = { 400: started + 10, 401: started + 20, 402: null };
    const tree = windowsTreeWithStartTimes(table, 400, (pid) => {
      asked.push(pid);
      if (pid === 401) throw new Error("access denied");
      return times[pid] ?? null;
    });
    expect(asked.sort()).toEqual([400, 401, 402]);
    expect(tree).toEqual([
      { pid: 400, parentPid: 4, startedAtMs: started + 10, executable: "app.exe" },
      { pid: 401, parentPid: 400, startedAtMs: null, executable: "helper.exe" },
      { pid: 402, parentPid: 401, startedAtMs: null, executable: "gone.exe" },
    ]);
    // Unknown start times fail closed: only the root is owned.
    expect(appControlOwnedTree(tree, 400, started)).toEqual({ pids: [400], deniedPids: [] });
  });

  it("converts FILETIME to epoch milliseconds", () => {
    const filetime = Buffer.alloc(8);
    filetime.writeBigUInt64LE((BigInt(started) + 11_644_473_600_000n) * 10_000n);
    expect(filetimeToEpochMs(filetime)).toBe(started);
    expect(filetimeToEpochMs(Buffer.alloc(8))).toBeNull();
  });

  it("reads the integrity RID from a TOKEN_MANDATORY_LABEL and blocks only a more privileged target (UIPI)", () => {
    const label = Buffer.alloc(64);
    label.writeBigUInt64LE(0x1234_5678n, 0);
    label.writeUInt32LE(0x60, 8);
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 16]).copy(label, 16);
    label.writeUInt32LE(WINDOWS_INTEGRITY.high, 24);
    expect(integrityRidFromTokenLabel(label)).toBe(WINDOWS_INTEGRITY.high);
    expect(integrityRidFromTokenLabel(Buffer.alloc(64))).toBeNull();
    expect(uipiBlocks(WINDOWS_INTEGRITY.high, WINDOWS_INTEGRITY.medium)).toBe(true);
    expect(uipiBlocks(WINDOWS_INTEGRITY.medium, WINDOWS_INTEGRITY.medium)).toBe(false);
    expect(uipiBlocks(WINDOWS_INTEGRITY.low, WINDOWS_INTEGRITY.medium)).toBe(false);
    expect(uipiBlocks(null, WINDOWS_INTEGRITY.medium)).toBe(false);
    expect(uipiBlocks(WINDOWS_INTEGRITY.system, null)).toBe(false);
  });
});

function bsdInfo(pid: number, parentPid: number, startedAtMs: number | null, command = "app"): Buffer {
  const buffer = Buffer.alloc(PROC_BSDINFO_BYTES);
  buffer.writeUInt32LE(pid, 12);
  buffer.writeUInt32LE(parentPid, 16);
  buffer.write(`${command}\u0000`, 48, "utf8");
  if (startedAtMs !== null) {
    buffer.writeBigUInt64LE(BigInt(Math.floor(startedAtMs / 1_000)), 120);
    buffer.writeBigUInt64LE(BigInt((startedAtMs % 1_000) * 1_000 + 7), 128);
  }
  return buffer;
}

/** A fake ffi-rs over a fake libproc: it writes into the caller's buffers the way the real calls do. */
function fakeLibproc(processes: Record<number, { parentPid: number; startedAtMs: number | null; path: string | null; children: number[] }>, countAsBytes = false) {
  const calls: string[] = [];
  const opened: unknown[] = [];
  const ffi = {
    DataType: { I32: "i32", I64: "i64", U32: "u32", U8Array: "u8array" },
    open: (library: unknown) => { opened.push(library); },
    load: ({ funcName, paramsValue }: { funcName: string; paramsValue: unknown[] }) => {
      const pid = paramsValue[0] as number;
      calls.push(`${funcName}:${pid}`);
      const process = processes[pid];
      switch (funcName) {
        case "proc_pidinfo": {
          if (!process) return 0;
          bsdInfo(pid, process.parentPid, process.startedAtMs).copy(paramsValue[3] as Buffer);
          return PROC_BSDINFO_BYTES;
        }
        case "proc_pidpath": {
          if (!process?.path) return 0;
          return (paramsValue[1] as Buffer).write(process.path, 0, "utf8");
        }
        case "proc_listchildpids": {
          const buffer = paramsValue[1] as Buffer;
          const children = process?.children ?? [];
          children.forEach((child, index) => buffer.writeInt32LE(child, index * 4));
          return countAsBytes ? children.length * 4 : children.length;
        }
        default: throw new Error(funcName);
      }
    },
  };
  return { ffi: ffi as never, calls, opened };
}

describe("macOS process facts (libproc)", () => {
  it("parses proc_bsdinfo, pid lists and pid paths defensively", () => {
    expect(parseBsdInfo(bsdInfo(100, 1, started + 250, "My App"), PROC_BSDINFO_BYTES, 100))
      .toEqual({ pid: 100, parentPid: 1, startedAtMs: started + 250, command: "My App" });
    expect(parseBsdInfo(bsdInfo(100, 1, started), PROC_BSDINFO_BYTES, 101)).toBeNull();
    expect(parseBsdInfo(bsdInfo(100, 1, started), 0, 100)).toBeNull();
    expect(parseBsdInfo(Buffer.alloc(10), 10, 100)).toBeNull();
    expect(parseBsdInfo(bsdInfo(100, 1, null), PROC_BSDINFO_BYTES, 100)).toMatchObject({ startedAtMs: null });

    const list = Buffer.alloc(16);
    list.writeInt32LE(7, 0);
    list.writeInt32LE(9, 4);
    list.writeInt32LE(7, 8);
    expect(parsePidList(list, 3)).toEqual([7, 9]);
    // An older libproc reports bytes: the zeroed tail is dropped.
    expect(parsePidList(list, 12)).toEqual([7, 9]);
    expect(parsePidList(list, -1)).toEqual([]);
    expect(parsePidList(list, 0)).toEqual([]);

    const path = Buffer.alloc(64);
    path.write("/Applications/My App.app/Contents/MacOS/My App\u0000junk");
    expect(parsePidPath(path, 46)).toBe("/Applications/My App.app/Contents/MacOS/My App");
    expect(parsePidPath(path, 0)).toBeNull();
    expect(parsePidPath(Buffer.from("relative"), 8)).toBeNull();
  });

  it("walks only the launch's own tree, bounded, without starting a process", () => {
    const { ffi, calls, opened } = fakeLibproc({
      100: { parentPid: 1, startedAtMs: started + 50, path: "/Applications/Guardian", children: [101, 103] },
      101: { parentPid: 100, startedAtMs: started + 60, path: "/Applications/My App.app/Contents/MacOS/My App", children: [102] },
      102: { parentPid: 101, startedAtMs: started + 70, path: null, children: [100] },
      // 103 exited between the listing and its read.
    });
    const facts = new MacProcessFacts(ffi);
    const entries = facts.processTree(100);
    expect(entries).toEqual([
      { pid: 100, parentPid: 1, startedAtMs: started + 50, executable: "/Applications/Guardian" },
      { pid: 101, parentPid: 100, startedAtMs: started + 60, executable: "/Applications/My App.app/Contents/MacOS/My App" },
      // No path: the short command name stands in for the denylist.
      { pid: 102, parentPid: 101, startedAtMs: started + 70, executable: "app" },
    ]);
    expect(opened).toEqual([{ library: "inertia-app-control-libsystem", path: "/usr/lib/libSystem.B.dylib" }]);
    // A cycle never revisits a process and no other pid is read.
    expect(new Set(calls.map((call) => Number(call.split(":")[1])))).toEqual(new Set([100, 101, 102, 103]));
    expect(appControlOwnedTree(entries, 100, started)).toEqual({ pids: [100, 101, 102], deniedPids: [] });
    facts.processTree(100);
    expect(opened).toHaveLength(1);
    expect(new MacProcessFacts(fakeLibproc({}).ffi).processTree(100)).toEqual([]);
    expect(new MacProcessFacts(fakeLibproc({ 5: { parentPid: 1, startedAtMs: started, path: "/a", children: [6] }, 6: { parentPid: 5, startedAtMs: started, path: "/b", children: [] } }, true).ffi)
      .processTree(5).map(({ pid }) => pid)).toEqual([5, 6]);
  });

  it("refuses a tree larger than the walk's bound instead of returning part of it", () => {
    const children = Array.from({ length: APP_CONTROL_MAX_TREE_PROCESSES }, (_, index) => 1_000 + index);
    const processes: Record<number, { parentPid: number; startedAtMs: number; path: string; children: number[] }> = {
      100: { parentPid: 1, startedAtMs: started, path: "/Applications/App", children },
    };
    for (const pid of children) processes[pid] = { parentPid: 100, startedAtMs: started + 1, path: "/Applications/Helper", children: [] };
    expect(() => new MacProcessFacts(fakeLibproc(processes).ffi).processTree(100)).toThrow(AppControlTreeTooLargeError);
  });

  it("feeds the denylist with full executable paths", () => {
    const { ffi } = fakeLibproc({
      100: { parentPid: 1, startedAtMs: started + 50, path: "/Applications/My App.app/Contents/MacOS/My App", children: [101] },
      101: { parentPid: 100, startedAtMs: started + 60, path: "/Applications/1Password.app/Contents/MacOS/1Password", children: [] },
    });
    expect(appControlOwnedTree(new MacProcessFacts(ffi).processTree(100), 100, started)).toEqual({ pids: [100, 101], deniedPids: [101] });
  });
});
