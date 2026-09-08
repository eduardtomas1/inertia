import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ open: vi.fn(), load: vi.fn() }));
vi.mock("ffi-rs", () => ({ default: { ...native, DataType: { I32: 1, I16: 17, Boolean: 6 } } }));
import { shiftPair } from "../../src/main/snapshot-shortcut-worker";
beforeEach(() => vi.resetAllMocks());

it.each([
  [false, false, false], [false, true, false], [true, false, false], [true, true, true],
])("reads the two physical macOS Shift keys separately: left=%s right=%s", (left, right, expected) => {
  native.load.mockImplementation((call) => {
    expect(call).toMatchObject({ funcName: "CGEventSourceKeyState", retType: 6, paramsType: [1, 17] });
    expect(call.paramsValue[0]).toBe(1);
    expect([0x38, 0x3c]).toContain(call.paramsValue[1]);
    return call.paramsValue[1] === 0x38 ? left : right;
  });
  const read = shiftPair("darwin");
  expect(read()).toBe(expected);
  expect(native.open).toHaveBeenCalledWith({ library: "inertia-snapshot-shift", path: "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics" });
});

it.each([
  [false, false, false], [false, true, false], [true, false, false], [true, true, true],
])("uses each Windows Shift key's down bit: left=%s right=%s", (left, right, expected) => {
  native.load.mockImplementation((call) => {
    expect(call).toMatchObject({ funcName: "GetAsyncKeyState", retType: 17, paramsType: [1] });
    expect([0xa0, 0xa1]).toContain(call.paramsValue[0]);
    return (call.paramsValue[0] === 0xa0 ? left : right) ? -32768 : 1;
  });
  expect(shiftPair("win32")()).toBe(expected);
});

it("leaves Linux key handling to the registered accelerator", () => {
  expect(() => shiftPair("linux")).toThrow("unsupported");
  expect(native.open).not.toHaveBeenCalled();
});
