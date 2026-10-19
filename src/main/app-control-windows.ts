import { appControlTreeCandidates, type AppControlProcessEntry } from "./app-control-process-tree.js";

/**
 * Windows process facts App control needs, read in the App control worker
 * through ffi-rs (the same binding Snapshots uses), never with a shell:
 * the process table (Toolhelp32), process start times, and token integrity
 * levels for the UIPI pre-flight. Parsing is pure so it is tested on every
 * platform; the native calls only run on Windows.
 */

/** sizeof(PROCESSENTRY32W) on 64-bit Windows. */
export const PROCESS_ENTRY_BYTES = 568;
const PROCESS_ID_OFFSET = 8;
const PARENT_PROCESS_ID_OFFSET = 32;
const EXE_FILE_OFFSET = 44;
const EXE_FILE_CHARS = 260;
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000;
const MANDATORY_LABEL_SID_PREFIX = [1, 1, 0, 0, 0, 0, 0, 16] as const;
const MAX_PROCESSES = 65_536;

export const WINDOWS_INTEGRITY = Object.freeze({ untrusted: 0x0000, low: 0x1000, medium: 0x2000, high: 0x3000, system: 0x4000 });

export function parseProcessEntry(entry: Buffer): { pid: number; parentPid: number; executable: string } | null {
  if (entry.byteLength < PROCESS_ENTRY_BYTES) return null;
  const pid = entry.readUInt32LE(PROCESS_ID_OFFSET);
  const parentPid = entry.readUInt32LE(PARENT_PROCESS_ID_OFFSET);
  const name = entry.subarray(EXE_FILE_OFFSET, EXE_FILE_OFFSET + EXE_FILE_CHARS * 2).toString("utf16le");
  const end = name.indexOf("\u0000");
  return { pid, parentPid, executable: (end < 0 ? name : name.slice(0, end)).slice(0, EXE_FILE_CHARS) };
}

/** A FILETIME (100 ns intervals since 1601) as epoch milliseconds. */
export function filetimeToEpochMs(filetime: Buffer): number | null {
  if (filetime.byteLength < 8) return null;
  const intervals = filetime.readBigUInt64LE(0);
  if (intervals === 0n) return null;
  const ms = Number(intervals / 10_000n) - FILETIME_UNIX_EPOCH_MS;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

/**
 * The integrity RID in a TOKEN_MANDATORY_LABEL buffer: its SID is a
 * mandatory-label SID (revision 1, one sub-authority, authority 16) whose only
 * sub-authority is the level. The SID follows the label structure in the same
 * buffer, so it is found by its fixed prefix instead of by pointer.
 */
export function integrityRidFromTokenLabel(buffer: Buffer): number | null {
  for (let offset = 8; offset + MANDATORY_LABEL_SID_PREFIX.length + 4 <= buffer.byteLength; offset += 4) {
    if (MANDATORY_LABEL_SID_PREFIX.every((byte, index) => buffer[offset + index] === byte)) {
      return buffer.readUInt32LE(offset + MANDATORY_LABEL_SID_PREFIX.length);
    }
  }
  return null;
}

/**
 * UIPI: a process may not drive the UI of a process with a higher integrity
 * level. Unknown levels do not block; the accessibility call then reports
 * its own denial.
 */
export function uipiBlocks(targetRid: number | null, ownRid: number | null): boolean {
  return targetRid !== null && ownRid !== null && targetRid > ownRid;
}

/**
 * The launch's candidate tree from a Toolhelp32 table, each member with its
 * own start time (`GetProcessTimes`). A pid whose start time cannot be read
 * keeps `null`, which the owned-tree check drops with its subtree.
 */
export function windowsTreeWithStartTimes(
  table: readonly AppControlProcessEntry[],
  rootPid: number,
  startedAtMs: (pid: number) => number | null,
): AppControlProcessEntry[] {
  const owned = appControlTreeCandidates(table, rootPid);
  return table.filter(({ pid }) => owned.has(pid)).map((entry) => {
    let started: number | null = null;
    try { started = startedAtMs(entry.pid); } catch { started = null; }
    return { ...entry, startedAtMs: started };
  });
}

type Ffi = Pick<typeof import("ffi-rs"), "open" | "load" | "DataType">;

const KERNEL32 = "inertia-app-control-kernel32";
const ADVAPI32 = "inertia-app-control-advapi32";
const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x8;
const TOKEN_INTEGRITY_LEVEL = 25;

export class WindowsProcessFacts {
  private opened = false;

  constructor(private readonly ffi: Ffi) {}

  private open(): void {
    if (this.opened) return;
    this.ffi.open({ library: KERNEL32, path: "kernel32.dll" });
    this.ffi.open({ library: ADVAPI32, path: "advapi32.dll" });
    this.opened = true;
  }

  private call<T>(library: string, funcName: string, retType: unknown, paramsType: unknown[], paramsValue: unknown[]): T {
    return this.ffi.load({ library, funcName, retType, paramsType, paramsValue } as never) as T;
  }

  private close(handle: number): void {
    const D = this.ffi.DataType;
    this.call(KERNEL32, "CloseHandle", D.I32, [D.I64], [handle]);
  }

  /** Process start time of one pid, or null when it cannot be opened. */
  startedAtMs(pid: number): number | null {
    this.open();
    const D = this.ffi.DataType;
    const handle = this.call<number>(KERNEL32, "OpenProcess", D.I64, [D.U32, D.I32, D.U32], [PROCESS_QUERY_LIMITED_INFORMATION, 0, pid]);
    if (!handle) return null;
    try {
      const times = Array.from({ length: 4 }, () => Buffer.alloc(8));
      const ok = this.call<number>(KERNEL32, "GetProcessTimes", D.I32, [D.I64, D.U8Array, D.U8Array, D.U8Array, D.U8Array], [handle, ...times]);
      return ok ? filetimeToEpochMs(times[0]!) : null;
    } finally { this.close(handle); }
  }

  processTable(): AppControlProcessEntry[] {
    this.open();
    const D = this.ffi.DataType;
    const snapshot = this.call<number>(KERNEL32, "CreateToolhelp32Snapshot", D.I64, [D.U32, D.U32], [TH32CS_SNAPPROCESS, 0]);
    if (!snapshot || snapshot === -1) throw new Error("The process table could not be read.");
    const entries: AppControlProcessEntry[] = [];
    try {
      const entry = Buffer.alloc(PROCESS_ENTRY_BYTES);
      entry.writeUInt32LE(PROCESS_ENTRY_BYTES, 0);
      let more = this.call<number>(KERNEL32, "Process32FirstW", D.I32, [D.I64, D.U8Array], [snapshot, entry]);
      while (more && entries.length < MAX_PROCESSES) {
        const parsed = parseProcessEntry(entry);
        if (parsed && parsed.pid > 0) entries.push({ ...parsed, startedAtMs: null });
        entry.fill(0);
        entry.writeUInt32LE(PROCESS_ENTRY_BYTES, 0);
        more = this.call<number>(KERNEL32, "Process32NextW", D.I32, [D.I64, D.U8Array], [snapshot, entry]);
      }
    } finally { this.close(snapshot); }
    return entries;
  }

  /** The launch's tree with every member's start time; throws when it is too large to check. */
  processTree(rootPid: number): AppControlProcessEntry[] {
    return windowsTreeWithStartTimes(this.processTable(), rootPid, (pid) => this.startedAtMs(pid));
  }

  /** Integrity RID of a process (or of this process with `self`), or null. */
  integrityRid(pid: number | "self"): number | null {
    this.open();
    const D = this.ffi.DataType;
    const process = pid === "self"
      ? this.call<number>(KERNEL32, "GetCurrentProcess", D.I64, [], [])
      : this.call<number>(KERNEL32, "OpenProcess", D.I64, [D.U32, D.I32, D.U32], [PROCESS_QUERY_LIMITED_INFORMATION, 0, pid]);
    if (!process) return null;
    try {
      const tokenOut = Buffer.alloc(8);
      if (!this.call<number>(ADVAPI32, "OpenProcessToken", D.I32, [D.I64, D.U32, D.U8Array], [process, TOKEN_QUERY, tokenOut])) return null;
      const token = Number(tokenOut.readBigInt64LE(0));
      try {
        const label = Buffer.alloc(128);
        const length = Buffer.alloc(4);
        const ok = this.call<number>(ADVAPI32, "GetTokenInformation", D.I32,
          [D.I64, D.I32, D.U8Array, D.U32, D.U8Array], [token, TOKEN_INTEGRITY_LEVEL, label, label.byteLength, length]);
        return ok ? integrityRidFromTokenLabel(label) : null;
      } finally { this.close(token); }
    } finally { if (pid !== "self") this.close(process); }
  }
}
