import {
  APP_CONTROL_MAX_TREE_PROCESSES,
  AppControlTreeTooLargeError,
  type AppControlProcessEntry,
} from "./app-control-process-tree.js";

/**
 * macOS process facts for App control, read in the App control worker through
 * ffi-rs from libproc (the binding Snapshots already uses for CoreGraphics):
 * the launch's descendants with `proc_listchildpids`, each one's parent and
 * start time with `proc_pidinfo(PROC_PIDTBSDINFO)` and its executable with
 * `proc_pidpath`. No process is started and only the launch's own tree is
 * walked. Parsing is pure so it is tested on every platform.
 */

/** sizeof(struct proc_bsdinfo). */
export const PROC_BSDINFO_BYTES = 136;
const PBI_PID_OFFSET = 12;
const PBI_PPID_OFFSET = 16;
const PBI_COMM_OFFSET = 48;
const MAXCOMLEN = 16;
const PBI_START_SEC_OFFSET = 120;
const PBI_START_USEC_OFFSET = 128;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDPATHINFO_MAXSIZE = 4096;
/** Children read per process; a launch with more is cut, never unbounded. */
const MAX_CHILDREN = 1_024;
const LIBSYSTEM = "inertia-app-control-libsystem";

export interface MacBsdInfo {
  pid: number;
  parentPid: number;
  /** Epoch milliseconds, or null when the kernel reported none. */
  startedAtMs: number | null;
  /** The short command name (MAXCOMLEN), the fallback when the path cannot be read. */
  command: string | null;
}

/** Parses one `struct proc_bsdinfo`; null when the buffer is short or names another process. */
export function parseBsdInfo(buffer: Buffer, written: number, expectedPid: number): MacBsdInfo | null {
  if (written < PROC_BSDINFO_BYTES || buffer.byteLength < PROC_BSDINFO_BYTES) return null;
  const pid = buffer.readUInt32LE(PBI_PID_OFFSET);
  if (pid !== expectedPid) return null;
  const seconds = buffer.readBigUInt64LE(PBI_START_SEC_OFFSET);
  const micros = buffer.readBigUInt64LE(PBI_START_USEC_OFFSET);
  const ms = seconds === 0n ? null : Number(seconds * 1_000n + micros / 1_000n);
  const comm = buffer.subarray(PBI_COMM_OFFSET, PBI_COMM_OFFSET + MAXCOMLEN).toString("utf8");
  const end = comm.indexOf("\u0000");
  const command = (end < 0 ? comm : comm.slice(0, end)) || null;
  return {
    pid,
    parentPid: buffer.readUInt32LE(PBI_PPID_OFFSET),
    startedAtMs: ms !== null && Number.isSafeInteger(ms) && ms > 0 ? ms : null,
    command,
  };
}

/**
 * The pids `proc_listchildpids` wrote. Its return value is a count on current
 * systems and a byte length on some older ones, so it only bounds the read;
 * the buffer is zeroed first and empty slots are dropped.
 */
export function parsePidList(buffer: Buffer, returned: number): number[] {
  if (!Number.isSafeInteger(returned) || returned <= 0) return [];
  const slots = Math.min(Math.floor(buffer.byteLength / 4), returned);
  const pids: number[] = [];
  for (let index = 0; index < slots; index += 1) {
    const pid = buffer.readInt32LE(index * 4);
    if (pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** A `proc_pidpath` result: the bytes before the first NUL, bounded by what it wrote. */
export function parsePidPath(buffer: Buffer, written: number): string | null {
  if (!Number.isSafeInteger(written) || written <= 0) return null;
  const text = buffer.subarray(0, Math.min(written, buffer.byteLength)).toString("utf8");
  const end = text.indexOf("\u0000");
  const path = end < 0 ? text : text.slice(0, end);
  return path.startsWith("/") ? path.slice(0, 1_024) : null;
}

type Ffi = Pick<typeof import("ffi-rs"), "open" | "load" | "DataType">;

export class MacProcessFacts {
  private opened = false;

  constructor(private readonly ffi: Ffi) {}

  private open(): void {
    if (this.opened) return;
    this.ffi.open({ library: LIBSYSTEM, path: "/usr/lib/libSystem.B.dylib" });
    this.opened = true;
  }

  private call<T>(funcName: string, retType: unknown, paramsType: unknown[], paramsValue: unknown[]): T {
    return this.ffi.load({ library: LIBSYSTEM, funcName, retType, paramsType, paramsValue } as never) as T;
  }

  private info(pid: number): MacBsdInfo | null {
    const D = this.ffi.DataType;
    const buffer = Buffer.alloc(PROC_BSDINFO_BYTES);
    const written = this.call<number>("proc_pidinfo", D.I32, [D.I32, D.I32, D.I64, D.U8Array, D.I32],
      [pid, PROC_PIDTBSDINFO, 0, buffer, buffer.byteLength]);
    return parseBsdInfo(buffer, written, pid);
  }

  private path(pid: number): string | null {
    const D = this.ffi.DataType;
    const buffer = Buffer.alloc(PROC_PIDPATHINFO_MAXSIZE);
    return parsePidPath(buffer, this.call<number>("proc_pidpath", D.I32, [D.I32, D.U8Array, D.U32], [pid, buffer, buffer.byteLength]));
  }

  private children(pid: number): number[] {
    const D = this.ffi.DataType;
    const buffer = Buffer.alloc(MAX_CHILDREN * 4);
    return parsePidList(buffer, this.call<number>("proc_listchildpids", D.I32, [D.I32, D.U8Array, D.I32], [pid, buffer, buffer.byteLength]));
  }

  /**
   * The root and its live descendants, breadth first and bounded. A process
   * that exits during the walk is left out; an empty table means the root is
   * gone. A tree larger than the bound throws instead of being read in part.
   */
  processTree(rootPid: number): AppControlProcessEntry[] {
    this.open();
    const entries: AppControlProcessEntry[] = [];
    const seen = new Set<number>();
    const queue = [rootPid];
    while (queue.length > 0 && entries.length < APP_CONTROL_MAX_TREE_PROCESSES) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const info = this.info(pid);
      if (!info) continue;
      entries.push({ pid, parentPid: info.parentPid, startedAtMs: info.startedAtMs, executable: this.path(pid) ?? info.command });
      const children = this.children(pid);
      // A full child buffer may have been cut: refuse rather than read part of the tree.
      if (children.length >= MAX_CHILDREN) throw new AppControlTreeTooLargeError();
      for (const child of children) if (!seen.has(child)) queue.push(child);
    }
    if (queue.some((pid) => !seen.has(pid))) throw new AppControlTreeTooLargeError();
    return entries;
  }
}
