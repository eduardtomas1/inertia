import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffi, { type DataType as FfiType, type JsExternal } from "ffi-rs";
import type { SnapshotRect } from "../shared/snapshots.js";
const { DataType, createPointer, freePointer, isNullPointer, load, open: openLibrary, PointerType, restorePointer } = ffi;

export interface MacWindowInfo { id: number; pid: number; layer: number; bounds: SnapshotRect; title: string | null }
export interface MacWindowTarget { pid: number; title: string | null; bounds: SnapshotRect }

const SCREENCAPTURE = "/usr/sbin/screencapture";
const MAX_WINDOW_PNG_BYTES = 256 * 1024 * 1024;
const MAX_TITLE_LENGTH = 1000;

function sameWindow(window: Omit<MacWindowInfo, "id" | "title">, target: MacWindowTarget): boolean {
  const near = (left: number, right: number): boolean => Math.abs(left - right) <= 1;
  return window.pid === target.pid && window.layer === 0
    && near(window.bounds.x, target.bounds.x) && near(window.bounds.y, target.bounds.y)
    && near(window.bounds.width, target.bounds.width) && near(window.bounds.height, target.bounds.height);
}

export function matchMacWindow(windows: readonly MacWindowInfo[], target: MacWindowTarget): MacWindowInfo | null {
  const candidates = windows.filter((window) => sameWindow(window, target));
  const titled = candidates.filter(({ title }) => !title || !target.title || title === target.title);
  return titled.length === 1 ? titled[0]! : null;
}

let libraries = false;
const keys = new Map<string, JsExternal>();
function call<T>(library: string, funcName: string, retType: FfiType, paramsType: FfiType[], paramsValue: unknown[]): T {
  return load({ library, funcName, retType, paramsType, paramsValue } as never) as T;
}
function key(name: string): JsExternal {
  let value = keys.get(name);
  if (!value) {
    value = call<JsExternal>("inertia-snapshot-cf", "CFStringCreateWithCString", DataType.External,
      [DataType.I64, DataType.String, DataType.U32], [0, name, 0x08000100]);
    keys.set(name, value);
  }
  return value;
}
function value(dictionary: JsExternal, name: string): JsExternal | null {
  const result = call<JsExternal>("inertia-snapshot-cf", "CFDictionaryGetValue", DataType.External,
    [DataType.External, DataType.External], [dictionary, key(name)]);
  return isNullPointer(result) ? null : result;
}
function number(reference: JsExternal | null): number | null {
  if (!reference) return null;
  const output = createPointer({ paramsType: [DataType.Double], paramsValue: [0] });
  try {
    const converted = call<boolean>("inertia-snapshot-cf", "CFNumberGetValue", DataType.Boolean,
      [DataType.External, DataType.I64, DataType.External], [reference, 13, output[0]]);
    const [result] = restorePointer({ retType: [DataType.Double], paramsValue: output }) as number[];
    return converted && Number.isFinite(result) ? result! : null;
  } finally { freePointer({ paramsType: [DataType.Double], paramsValue: output, pointerType: PointerType.RsPointer }); }
}
function text(reference: JsExternal | null): string | null {
  if (!reference) return null;
  const length = call<number>("inertia-snapshot-cf", "CFStringGetLength", DataType.I64, [DataType.External], [reference]);
  const units: number[] = [];
  for (let index = 0; index < Math.min(length, MAX_TITLE_LENGTH); index += 1) {
    units.push(call<number>("inertia-snapshot-cf", "CFStringGetCharacterAtIndex", DataType.I32,
      [DataType.External, DataType.I64], [reference, index]) & 0xffff);
  }
  return String.fromCharCode(...units) || null;
}

export function listMacWindows(target: MacWindowTarget): MacWindowInfo[] {
  if (!libraries) {
    openLibrary({ library: "inertia-snapshot-cg", path: "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics" });
    openLibrary({ library: "inertia-snapshot-cf", path: "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation" });
    libraries = true;
  }
  const list = call<JsExternal>("inertia-snapshot-cg", "CGWindowListCopyWindowInfo", DataType.External,
    [DataType.U32, DataType.U32], [1 | 16, 0]);
  if (isNullPointer(list)) return [];
  try {
    const count = call<number>("inertia-snapshot-cf", "CFArrayGetCount", DataType.I64, [DataType.External], [list]);
    const windows: MacWindowInfo[] = [];
    for (let index = 0; index < Math.min(count, 4096); index += 1) {
      const entry = call<JsExternal>("inertia-snapshot-cf", "CFArrayGetValueAtIndex", DataType.External,
        [DataType.External, DataType.I64], [list, index]);
      const bounds = value(entry, "kCGWindowBounds");
      const fields = [value(entry, "kCGWindowNumber"), value(entry, "kCGWindowOwnerPID"), value(entry, "kCGWindowLayer"),
        ...(bounds ? ["X", "Y", "Width", "Height"].map((name) => value(bounds, name)) : [])].map(number);
      if (fields.length !== 7 || fields.some((field) => field === null)) continue;
      const [id, pid, layer, x, y, width, height] = fields as number[];
      const window = { id: id!, pid: pid!, layer: layer!, bounds: { x: x!, y: y!, width: width!, height: height! } };
      windows.push({ ...window, title: sameWindow(window, target) ? text(value(entry, "kCGWindowName")) : null });
    }
    return windows;
  } finally { call("inertia-snapshot-cf", "CFRelease", DataType.Void, [DataType.External], [list]); }
}

export async function captureMacWindowPng(id: number, timeoutMs = 3000): Promise<Buffer> {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffff_ffff) throw new Error("Invalid window.");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "inertia-snapshot-")));
  try {
    const output = join(directory, "window.png");
    await new Promise<void>((resolve, reject) => {
      execFile(SCREENCAPTURE, ["-l", String(id), "-o", "-x", "-t", "png", output], {
        timeout: timeoutMs, killSignal: "SIGKILL", env: {}, maxBuffer: 64 * 1024, windowsHide: true,
      }, (error) => { if (error) reject(error); else resolve(); });
    });
    const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_WINDOW_PNG_BYTES) throw new Error("Invalid window image.");
      return await handle.readFile();
    } finally { await handle.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export const macWindowPixels = {
  locate(target: MacWindowTarget): { id: number; frame: SnapshotRect } | null {
    const window = matchMacWindow(listMacWindows(target), target);
    return window ? { id: window.id, frame: window.bounds } : null;
  },
  capture: (id: number): Promise<Buffer> => captureMacWindowPng(id),
};
