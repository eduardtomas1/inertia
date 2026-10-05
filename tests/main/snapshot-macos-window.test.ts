import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: native.execFile }));
import { captureMacWindowPng, listMacWindows, matchMacWindow, type MacWindowInfo } from "../../src/main/snapshot-macos-window";

const bounds = { x: 50, y: 60, width: 800, height: 600 };
function window(id: number, overrides: Partial<MacWindowInfo> = {}): MacWindowInfo {
  return { id, pid: 123, layer: 0, bounds, title: null, ...overrides };
}
const target = { pid: 123, title: "Release checklist", bounds };
afterEach(() => { vi.clearAllMocks(); });

describe("macOS window matching", () => {
  it("matches the accessibility window by process and bounds when titles are unavailable", () => {
    expect(matchMacWindow([window(7, { pid: 99 }), window(8), window(9, { layer: 25 })], target)?.id).toBe(8);
  });
  it("tolerates one point of rounding between accessibility and window server bounds", () => {
    expect(matchMacWindow([window(8, { bounds: { x: 50.5, y: 59, width: 801, height: 600 } })], target)?.id).toBe(8);
    expect(matchMacWindow([window(8, { bounds: { ...bounds, width: 802 } })], target)).toBeNull();
  });
  it("uses titles to separate same-sized windows of one process", () => {
    expect(matchMacWindow([window(8, { title: "Other note" }), window(9, { title: "Release checklist" })], target)?.id).toBe(9);
    expect(matchMacWindow([window(8, { title: "Other note" })], target)).toBeNull();
  });
  it("refuses to guess between indistinguishable windows", () => {
    expect(matchMacWindow([window(8), window(9)], target)).toBeNull();
    expect(matchMacWindow([], target)).toBeNull();
  });
});

describe("macOS window pixels", () => {
  it("runs screencapture for one window without a shell, sound, shadow or inherited environment", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    native.execFile.mockImplementation((_file: string, args: string[], _options: unknown, done: (error: Error | null) => void) => {
      void writeFile(args.at(-1)!, png).then(() => done(null), done);
    });
    await expect(captureMacWindowPng(4242, 1500)).resolves.toEqual(png);
    const [file, args, options] = native.execFile.mock.calls[0]!;
    expect(file).toBe("/usr/sbin/screencapture");
    expect(args.slice(0, -1)).toEqual(["-l", "4242", "-o", "-x", "-t", "png"]);
    expect(options).toMatchObject({ timeout: 1500, killSignal: "SIGKILL", env: {} });
    expect(options).not.toHaveProperty("shell");
  });
  it("removes its private output directory when capture fails", async () => {
    let output = "";
    native.execFile.mockImplementation((_file: string, args: string[], _options: unknown, done: (error: Error | null) => void) => {
      output = args.at(-1)!;
      void writeFile(output, "partial").then(() => done(new Error("timed out")));
    });
    await expect(captureMacWindowPng(4242)).rejects.toThrow("timed out");
    const { access } = await import("node:fs/promises");
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([0, -1, 1.5, 2 ** 32])("refuses window number %s", async (id) => {
    await expect(captureMacWindowPng(id)).rejects.toThrow("Invalid window.");
    expect(native.execFile).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform === "darwin")("macOS window server list", () => {
  it("reads window numbers, owners, layers and bounds through CoreGraphics", () => {
    const windows = listMacWindows({ pid: -1, title: null, bounds });
    for (const entry of windows) {
      expect(Number.isSafeInteger(entry.id) && Number.isSafeInteger(entry.pid) && Number.isSafeInteger(entry.layer)).toBe(true);
      expect(Object.values(entry.bounds).every(Number.isFinite)).toBe(true);
      expect(entry.title).toBeNull();
    }
  });
});
