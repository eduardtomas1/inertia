import { describe, expect, it, vi } from "vitest";

import {
  X11ForegroundWindow,
  x11ForegroundPid,
  x11Item,
  x11PropertyAddress,
  type X11PropertyReply,
} from "../../src/main/app-control-x11";

function word(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function reply(overrides: Partial<{ status: number; type: bigint; format: number; items: bigint; data: bigint }> = {}): X11PropertyReply {
  const format = Buffer.alloc(4);
  format.writeInt32LE(overrides.format ?? 32);
  return {
    status: overrides.status ?? 0,
    actualType: word(overrides.type ?? 33n),
    actualFormat: format,
    items: word(overrides.items ?? 1n),
    data: word(overrides.data ?? 0x5000n),
  };
}

describe("X11 foreground window", () => {
  it("accepts exactly one format-32 item of the expected type", () => {
    expect(x11PropertyAddress(reply(), 33)).toBe(0x5000n);
    for (const broken of [
      reply({ status: 1 }), reply({ type: 6n }), reply({ format: 8 }), reply({ items: 0n }), reply({ data: 0n }),
    ]) expect(x11PropertyAddress(broken, 33)).toBeNull();
    expect(x11Item(word(0x400003n), "window")).toBe(0x400003);
    expect(x11Item(word(0n), "window")).toBeNull();
    expect(x11Item(word(1n << 33n), "window")).toBeNull();
    expect(x11Item(word(4_321n), "pid")).toBe(4_321);
    expect(x11Item(word(1n), "pid")).toBeNull();
    expect(x11Item(word(1n << 31n), "pid")).toBeNull();
  });

  it("reads _NET_ACTIVE_WINDOW, then its _NET_WM_PID, with a no-op error handler installed while the display is open", () => {
    const { x11, ffi, calls, properties } = fakeX11();
    expect(x11.read(":99")).toEqual({ available: true, pid: 4_321 });
    expect(calls).toEqual([
      "XOpenDisplay", "XSetErrorHandler", "XDefaultRootWindow",
      "XInternAtom", "XGetWindowProperty", "memcpy", "XFree",
      "XInternAtom", "XGetWindowProperty", "memcpy", "XFree",
      "XSync", "XSetErrorHandler", "XCloseDisplay",
    ]);
    expect(ffi.open).toHaveBeenCalledOnce();
    // The handler is an ffi-rs callback created once and reused for every display.
    expect(ffi.createPointer).toHaveBeenCalledOnce();
    expect(ffi.funcConstructor).toHaveBeenCalledWith({ paramsType: ["U64", "U64"], retType: "Void" });
    expect(ffi.handlers[0]!(1, 2)).toBeUndefined();
    const installs = ffi.load.mock.calls.filter(([options]) => options.funcName === "XSetErrorHandler").map(([options]) => options.paramsValue[0]);
    expect(installs).toEqual([ffi.unwrapped, "previous-handler"]);

    // The active window vanished between the reads (BadWindow): the failed request is final, nothing in front of it.
    properties.delete(`${0x400003}:101`);
    calls.length = 0;
    expect(x11.read(":99")).toEqual({ available: true, pid: null });
    expect(calls.slice(-3)).toEqual(["XSync", "XSetErrorHandler", "XCloseDisplay"]);
    expect(ffi.createPointer).toHaveBeenCalledOnce();
  });

  it("reports X11 unavailable without a display, an EWMH window manager, libX11's word size or the error handler", () => {
    const { x11, ffi, calls, properties } = fakeX11();
    // No _NET_ACTIVE_WINDOW on the root: no EWMH window manager.
    properties.clear();
    expect(x11.read(":99")).toEqual({ available: false });
    expect(calls.at(-1)).toBe("XCloseDisplay");
    expect(x11.read(undefined)).toEqual({ available: false });
    ffi.load.mockImplementationOnce(() => null as never);
    expect(x11.read(":99")).toEqual({ available: false });
    // Xlib's out-parameters are eight bytes only on x64 and arm64.
    const ia32 = fakeX11("ia32");
    expect(ia32.x11.read(":99")).toEqual({ available: false });
    expect(ia32.calls).toEqual([]);
    // Without the no-op error handler nothing is read: a vanished window would end the worker.
    const noCallback = fakeX11();
    noCallback.ffi.createPointer.mockImplementation(() => { throw new Error("no callbacks"); });
    expect(noCallback.x11.read(":99")).toEqual({ available: false });
    expect(noCallback.calls).toEqual([]);
  });

  it("treats a successful X11 read as final and asks the accessibility API only when X11 is unavailable", async () => {
    const fallback = vi.fn(async () => 777);
    const reader = (read: ReturnType<X11ForegroundWindow["read"]> | Error) => ({
      read: vi.fn(() => { if (read instanceof Error) throw read; return read; }),
    });
    await expect(x11ForegroundPid(reader({ available: true, pid: 4_321 }), ":0", fallback)).resolves.toBe(4_321);
    // Nothing active, or an active window without a pid: final, never xa11y's guess.
    await expect(x11ForegroundPid(reader({ available: true, pid: null }), ":0", fallback)).resolves.toBeNull();
    expect(fallback).not.toHaveBeenCalled();
    await expect(x11ForegroundPid(reader({ available: false }), ":0", fallback)).resolves.toBe(777);
    await expect(x11ForegroundPid(reader(new Error("no libX11")), ":0", fallback)).resolves.toBe(777);
    await expect(x11ForegroundPid(reader({ available: true, pid: 1 }), undefined, fallback)).resolves.toBe(777);
    await expect(x11ForegroundPid(null, ":0", fallback)).resolves.toBe(777);
    expect(fallback).toHaveBeenCalledTimes(4);
  });
});

function fakeX11(arch = "x64") {
  const calls: string[] = [];
  const memory = new Map<number, bigint>([[0x5000, 0x400003n], [0x6000, 4_321n]]);
  const properties = new Map<string, { type: bigint; address: number }>([
    ["1:100", { type: 33n, address: 0x5000 }],
    [`${0x400003}:101`, { type: 6n, address: 0x6000 }],
  ]);
  const display = { display: true };
  const handlers: Array<(...args: unknown[]) => unknown> = [];
  const unwrapped = { handler: true };
  const load = vi.fn(({ funcName, paramsValue }: { funcName: string; paramsValue: unknown[] }) => {
    calls.push(funcName);
    switch (funcName) {
      case "XOpenDisplay": return display;
      case "XSetErrorHandler": return "previous-handler";
      case "XDefaultRootWindow": return 1;
      case "XInternAtom": return paramsValue[1] === "_NET_ACTIVE_WINDOW" ? 100 : 101;
      case "XGetWindowProperty": {
        const property = properties.get(`${String(paramsValue[1])}:${String(paramsValue[2])}`);
        const [type, format, items, , data] = paramsValue.slice(7) as Buffer[];
        // A missing property is a success with type None; a vanished window is BadWindow.
        if (!property) return paramsValue[1] === 1 ? 0 : 3;
        type!.writeBigUInt64LE(property.type);
        format!.writeInt32LE(32);
        items!.writeBigUInt64LE(1n);
        data!.writeBigUInt64LE(BigInt(property.address));
        return 0;
      }
      case "memcpy": {
        (paramsValue[0] as Buffer).writeBigUInt64LE(memory.get(paramsValue[1] as number) ?? 0n);
        return 0;
      }
      default: return 0;
    }
  });
  const ffi = {
    open: vi.fn(),
    load,
    DataType: new Proxy({}, { get: (_target, key) => String(key) }),
    isNullPointer: (value: unknown) => value === null,
    funcConstructor: vi.fn((options: unknown) => options),
    createPointer: vi.fn(({ paramsValue }: { paramsValue: Array<(...args: unknown[]) => unknown> }) => {
      handlers.push(paramsValue[0]!);
      return [{ pointer: true }];
    }),
    unwrapPointer: vi.fn(() => [unwrapped]),
    handlers,
    unwrapped,
  };
  return { x11: new X11ForegroundWindow(ffi as never, "libX11.so.6", arch), ffi, calls, properties };
}
