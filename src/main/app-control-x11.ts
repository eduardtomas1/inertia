/**
 * The X11 foreground process for App control's synthesized input, read in
 * the App control worker through ffi-rs from libX11: the window manager's
 * `_NET_ACTIVE_WINDOW` on the root window, then that window's `_NET_WM_PID`.
 * XTest delivers keys to the focused window, and an EWMH window manager
 * focuses the active one. Chromium and Electron do not report the AT-SPI
 * active state xa11y's own foreground query relies on, so on X11 this is the
 * reliable source. No process is started; the display is opened and closed
 * for each read. Parsing is pure so it is tested on every platform.
 *
 * Xlib's default error handler exits the process, and the active window can
 * close between the two property reads (a `BadWindow` error). While the
 * display is open a no-op error handler is installed through an ffi-rs
 * callback, kept alive for the reader's lifetime; the failed request then
 * just reports failure. Without that handler nothing is read. A lost
 * connection to the X server (Xlib's I/O error handler) still ends the
 * worker, which main then recycles.
 */

const LIBX11 = "inertia-app-control-x11";
const SUCCESS = 0;
const ANY_PROPERTY_TYPE = 0;
const XA_CARDINAL = 6;
const XA_WINDOW = 33;
/** A pointer or `unsigned long` in client memory on the 64-bit platforms Inertia ships. */
const WORD_BYTES = 8;

/** What one `XGetWindowProperty` call wrote into its out-parameters. */
export interface X11PropertyReply {
  status: number;
  actualType: Buffer;
  actualFormat: Buffer;
  items: Buffer;
  data: Buffer;
}

/**
 * The address of a property's first 32-bit item, or null when the reply is
 * not one item of the expected type and format. Format-32 items are stored
 * as `long` in client memory.
 */
export function x11PropertyAddress(reply: X11PropertyReply, expectedType: number): bigint | null {
  if (reply.status !== SUCCESS) return null;
  if (reply.actualType.readBigUInt64LE(0) !== BigInt(expectedType)) return null;
  if (reply.actualFormat.readInt32LE(0) !== 32) return null;
  if (reply.items.readBigUInt64LE(0) < 1n) return null;
  const address = reply.data.readBigUInt64LE(0);
  return address === 0n ? null : address;
}

/** A window id or pid from one format-32 item; null when it is out of range. */
export function x11Item(word: Buffer, kind: "window" | "pid"): number | null {
  const value = word.readBigUInt64LE(0);
  if (kind === "pid") return value > 1n && value <= 0x7fff_ffffn ? Number(value) : null;
  return value > 0n && value <= 0xffff_ffffn ? Number(value) : null;
}

type Ffi = Pick<
  typeof import("ffi-rs"),
  "open" | "load" | "DataType" | "isNullPointer" | "createPointer" | "funcConstructor" | "unwrapPointer"
>;
type External = Parameters<typeof import("ffi-rs").isNullPointer>[0];

/**
 * One read of the window manager's foreground: `available: false` when libX11,
 * the display or an EWMH window manager is missing (the caller may ask the
 * accessibility API instead); otherwise the pid of the active window, or null
 * when nothing is active or the active window names no process, which is final.
 */
export type X11ForegroundRead = { available: false } | { available: true; pid: number | null };

/** The X11 answer when there is one; the accessibility API's only without libX11 or an EWMH window manager. */
export async function x11ForegroundPid(
  reader: Pick<X11ForegroundWindow, "read"> | null,
  display: string | undefined,
  fallback: () => Promise<number | null>,
): Promise<number | null> {
  if (reader && display) {
    let read: X11ForegroundRead = { available: false };
    try {
      read = reader.read(display);
    } catch {
      // No libX11: the accessibility answer stands.
    }
    if (read.available) return read.pid;
  }
  return await fallback();
}

/** Xlib's `unsigned long` and pointer out-parameters are eight bytes only on these targets. */
const WORD_ARCHES: ReadonlySet<string> = new Set(["x64", "arm64"]);

export class X11ForegroundWindow {
  private opened = false;
  /** The no-op Xlib error handler; created once and never freed while the reader lives. */
  private handler: unknown[] | null = null;

  constructor(
    private readonly ffi: Ffi,
    private readonly libraryPath = "libX11.so.6",
    private readonly arch: string = process.arch,
  ) {}

  private call<T>(funcName: string, retType: unknown, paramsType: unknown[], paramsValue: unknown[]): T {
    return this.ffi.load({ library: LIBX11, funcName, retType, paramsType, paramsValue } as never) as T;
  }

  /**
   * Reads one format-32 item of `property` on `window`: undefined when the
   * window has no such property (or the atom does not exist), null when the
   * read failed or the item is out of range.
   */
  private item(display: External, window: number, property: string, type: number, kind: "window" | "pid"): number | null | undefined {
    const D = this.ffi.DataType;
    const atom = this.call<number>("XInternAtom", D.U64, [D.External, D.String, D.I32], [display, property, 1]);
    if (!atom) return undefined;
    const reply: X11PropertyReply = {
      status: -1,
      actualType: Buffer.alloc(WORD_BYTES),
      actualFormat: Buffer.alloc(4),
      items: Buffer.alloc(WORD_BYTES),
      data: Buffer.alloc(WORD_BYTES),
    };
    const remaining = Buffer.alloc(WORD_BYTES);
    reply.status = this.call<number>("XGetWindowProperty", D.I32, [
      D.External, D.U64, D.U64, D.I64, D.I64, D.I32, D.U64, D.U8Array, D.U8Array, D.U8Array, D.U8Array, D.U8Array,
    ], [display, window, atom, 0, 1, 0, ANY_PROPERTY_TYPE, reply.actualType, reply.actualFormat, reply.items, remaining, reply.data]);
    const address = x11PropertyAddress(reply, type);
    const pointer = reply.data.readBigUInt64LE(0);
    try {
      // Success with type None: the property does not exist on the window.
      if (reply.status === SUCCESS && reply.actualType.readBigUInt64LE(0) === 0n) return undefined;
      if (address === null || address > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const word = Buffer.alloc(WORD_BYTES);
      // Copies the item out of Xlib's buffer; the address came from Xlib itself.
      this.call<number>("memcpy", D.U64, [D.U8Array, D.U64, D.U64], [word, Number(address), WORD_BYTES]);
      return x11Item(word, kind);
    } finally {
      if (pointer !== 0n && pointer <= BigInt(Number.MAX_SAFE_INTEGER)) this.call("XFree", D.I32, [D.U64], [Number(pointer)]);
    }
  }

  /** Xlib calls an error handler with the display and the error event; it ignores the return value. */
  private errorHandler(): unknown[] {
    if (this.handler) return this.handler;
    const D = this.ffi.DataType;
    this.handler = this.ffi.createPointer({
      paramsType: [this.ffi.funcConstructor({ paramsType: [D.U64, D.U64], retType: D.Void })],
      paramsValue: [() => undefined],
    });
    return this.handler;
  }

  /** The window manager's active window and its process, read with Xlib errors contained. */
  read(display: string | undefined): X11ForegroundRead {
    if (!display || !WORD_ARCHES.has(this.arch)) return { available: false };
    const D = this.ffi.DataType;
    if (!this.opened) {
      this.ffi.open({ library: LIBX11, path: this.libraryPath });
      this.opened = true;
    }
    // Without a no-op error handler a vanished window would end the process: read nothing.
    let handler: unknown[];
    try {
      handler = this.errorHandler();
    } catch {
      return { available: false };
    }
    const connection = this.call<External>("XOpenDisplay", D.External, [D.String], [display]);
    if (this.ffi.isNullPointer(connection)) return { available: false };
    const previous = this.call<External>("XSetErrorHandler", D.External, [D.External], this.ffi.unwrapPointer(handler as never));
    try {
      const root = this.call<number>("XDefaultRootWindow", D.U64, [D.External], [connection]);
      if (!root) return { available: false };
      const active = this.item(connection, root, "_NET_ACTIVE_WINDOW", XA_WINDOW, "window");
      // No `_NET_ACTIVE_WINDOW` on the root: no EWMH window manager.
      if (active === undefined) return { available: false };
      if (active === null) return { available: true, pid: null };
      const pid = this.item(connection, active, "_NET_WM_PID", XA_CARDINAL, "pid");
      return { available: true, pid: pid ?? null };
    } finally {
      // Errors of this display are handled before the previous handler returns.
      this.call("XSync", D.I32, [D.External, D.I32], [connection, 0]);
      this.call("XSetErrorHandler", D.External, [D.External], [previous]);
      this.call("XCloseDisplay", D.I32, [D.External], [connection]);
    }
  }
}
