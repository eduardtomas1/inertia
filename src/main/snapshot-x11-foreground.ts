import ffi from "ffi-rs";
import type { SnapshotRect } from "../shared/snapshots.js";

const { DataType: D, load, open, isNullPointer } = ffi;
const library = "inertia-snapshot-x11";

export class SnapshotX11ForegroundError extends Error {}

interface X11Foreground {
  id: number; pid: number; name: string; bounds: SnapshotRect; frameBounds: SnapshotRect;
}

/** Read only the window manager's active client identity, in the bounded capture worker. */
export function readX11Foreground(): X11Foreground {
  // Xlib's unsigned long/pointer outputs are eight bytes on our two Linux targets.
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)
    || !process.env.DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
    throw new SnapshotX11ForegroundError();
  }
  open({ library, path: "libX11.so.6" });
  const display = load({ library, funcName: "XOpenDisplay", retType: D.External, paramsType: [D.String], paramsValue: [process.env.DISPLAY] });
  if (isNullPointer(display)) throw new SnapshotX11ForegroundError();
  try {
    const atom = (name: string): number => load({ library, funcName: "XInternAtom", retType: D.U64,
      paramsType: [D.External, D.String, D.I32], paramsValue: [display, name, 1] });
    const property = (window: number, name: string, type: string, format: 8 | 32, limit: number, optional = false): Buffer => {
      const requestedType = atom(type), propertyAtom = atom(name);
      if (optional && !propertyAtom) return Buffer.alloc(0);
      if (!requestedType || !propertyAtom) throw new SnapshotX11ForegroundError();
      const actual = Buffer.alloc(8), bits = Buffer.alloc(4), count = Buffer.alloc(8), rest = Buffer.alloc(8), pointer = Buffer.alloc(8);
      const result = load({ library, funcName: "XGetWindowProperty", retType: D.I32,
        paramsType: [D.External, D.U64, D.U64, D.I64, D.I64, D.I32, D.U64, D.U8Array, D.U8Array, D.U8Array, D.U8Array, D.U8Array],
        paramsValue: [display, window, propertyAtom, 0, limit, 0, requestedType, actual, bits, count, rest, pointer] });
      const address = pointer.readBigUInt64LE();
      try {
        if (optional && result === 0 && actual.readBigUInt64LE() === 0n && count.readBigUInt64LE() === 0n
          && rest.readBigUInt64LE() === 0n && address === 0n) return Buffer.alloc(0);
        if (result !== 0 || actual.readBigUInt64LE() !== BigInt(requestedType) || bits.readInt32LE() !== format
          || rest.readBigUInt64LE() !== 0n || address === 0n) throw new SnapshotX11ForegroundError();
        // Xlib stores format-32 properties in native longs, not packed uint32s.
        const items = count.readBigUInt64LE();
        if (items === 0n || items > BigInt(format === 32 ? limit : limit * 4)) throw new SnapshotX11ForegroundError();
        const output = Buffer.alloc(Number(items) * (format === 32 ? 8 : 1));
        load({ library, funcName: "memcpy", retType: D.Void, paramsType: [D.U8Array, D.BigInt, D.U64], paramsValue: [output, address, output.length] });
        return output;
      } finally {
        if (address !== 0n) load({ library, funcName: "XFree", retType: D.I32, paramsType: [D.BigInt], paramsValue: [address] });
      }
    };
    const root = load({ library, funcName: "XDefaultRootWindow", retType: D.U64, paramsType: [D.External], paramsValue: [display] });
    const id = Number(property(root, "_NET_ACTIVE_WINDOW", "WINDOW", 32, 1).readBigUInt64LE());
    if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffff_ffff) throw new SnapshotX11ForegroundError();
    const pid = Number(property(id, "_NET_WM_PID", "CARDINAL", 32, 1).readBigUInt64LE());
    const name = property(id, "_NET_WM_NAME", "UTF8_STRING", 8, 1024).toString("utf8");
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff || !name || name.includes("\0")) throw new SnapshotX11ForegroundError();
    const geometry = Array.from({ length: 7 }, () => Buffer.alloc(8));
    const positioned = Array.from({ length: 3 }, () => Buffer.alloc(8));
    const found = load({ library, funcName: "XGetGeometry", retType: D.I32,
      paramsType: [D.External, D.U64, D.U8Array, D.U8Array, D.U8Array, D.U8Array, D.U8Array, D.U8Array, D.U8Array], paramsValue: [display, id, ...geometry] });
    const translated = load({ library, funcName: "XTranslateCoordinates", retType: D.I32,
      paramsType: [D.External, D.U64, D.U64, D.I32, D.I32, D.U8Array, D.U8Array, D.U8Array], paramsValue: [display, id, root, 0, 0, ...positioned] });
    const bounds = { x: positioned[0]!.readInt32LE(), y: positioned[1]!.readInt32LE(), width: geometry[3]!.readUInt32LE(), height: geometry[4]!.readUInt32LE() };
    if (!found || !translated || bounds.width <= 0 || bounds.height <= 0 || bounds.width * bounds.height > 32_000_000) throw new SnapshotX11ForegroundError();
    const extents = property(id, "_NET_FRAME_EXTENTS", "CARDINAL", 32, 4, true);
    if (extents.length !== 0 && extents.length !== 32) throw new SnapshotX11ForegroundError();
    const extent = (offset: number): number => extents.length === 0 ? 0 : Number(extents.readBigUInt64LE(offset));
    const left = extent(0), right = extent(8), top = extent(16), bottom = extent(24);
    if (![left, right, top, bottom].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 32_768)) throw new SnapshotX11ForegroundError();
    const frameBounds = { x: bounds.x - left, y: bounds.y - top, width: bounds.width + left + right, height: bounds.height + top + bottom };
    if (frameBounds.width * frameBounds.height > 32_000_000) throw new SnapshotX11ForegroundError();
    return { id, pid, name, bounds, frameBounds };
  } finally {
    load({ library, funcName: "XCloseDisplay", retType: D.I32, paramsType: [D.External], paramsValue: [display] });
  }
}

export function x11CaptureBounds(logical: SnapshotRect | null, native: Pick<X11Foreground, "bounds" | "frameBounds">): SnapshotRect | null {
  const matched = [native.bounds, native.frameBounds].find((pixels) => matchesX11Bounds(logical, pixels));
  if (!matched || !logical) return null;
  const scale = matched.width / logical.width;
  return { x: native.bounds.x / scale, y: native.bounds.y / scale, width: native.bounds.width / scale, height: native.bounds.height / scale };
}

/** AT-SPI uses logical coordinates; X11 uses pixels. Require one uniform scale. */
export function matchesX11Bounds(logical: SnapshotRect | null, pixels: SnapshotRect): boolean {
  if (!logical || !Object.values(logical).every(Number.isFinite) || logical.width <= 0 || logical.height <= 0) return false;
  const scale = pixels.width / logical.width;
  return scale >= 0.5 && scale <= 8 && Math.abs(logical.height * scale - pixels.height) <= 1
    && Math.abs(logical.x * scale - pixels.x) <= 1 && Math.abs(logical.y * scale - pixels.y) <= 1;
}
