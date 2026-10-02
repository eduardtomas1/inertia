import type * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWithinScratchRoot } from "../../src/server/scratch-root";

const stub = vi.hoisted(() => ({ native: new Map<string, string>(), ino: 0n }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const native = ((path: fs.PathLike) => {
    const value = stub.native.get(String(path));
    if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return value;
  }) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(((path: fs.PathLike) => String(path)) as typeof actual.realpathSync, { native });
  const statSync = (() => ({ dev: 0n, ino: stub.ino })) as unknown as typeof actual.statSync;
  const overrides = { realpathSync, statSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const data = "C:\\Users\\Me\\AppData\\Roaming\\Inertia\\runtime";
const root = `${data}\\scratch`;

beforeEach(() => {
  stub.native.clear();
  stub.ino = 0n;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  stub.native.set(join(data, "scratch"), root);
});
afterEach(() => { Object.defineProperty(process, "platform", platform); });

function inside(returned: string): boolean {
  stub.native.set("candidate", returned);
  return isWithinScratchRoot(data, "candidate");
}

describe("managed folder containment by Windows path when file identities are missing", () => {
  it("catches spellings that canonicalise to the root", () => {
    expect(inside(`${data}\\SCRATCH`)).toBe(true);
    expect(inside(`${data.toLowerCase()}\\scratch\\chat`)).toBe(true);
    expect(inside(`${root}\\`)).toBe(true);
    expect(inside(`${data}\\x\\..\\scratch\\.\\chat`)).toBe(true);
    expect(inside(`c:${root.slice(2)}`)).toBe(true);
  });

  it("leaves extended-length and short-name spellings to the identity check", () => {
    expect(inside(`\\\\?\\${root}\\chat`)).toBe(false);
    expect(inside(`${data}\\SCRATC~1`)).toBe(false);
  });

  it("UNC roots compare by path", () => {
    stub.native.set(join(data, "scratch"), "\\\\server\\share\\Inertia\\scratch");
    expect(inside("\\\\server\\share\\Inertia\\scratch\\chat")).toBe(true);
    expect(inside("\\\\SERVER\\SHARE\\inertia\\SCRATCH")).toBe(true);
    expect(inside("\\\\?\\UNC\\server\\share\\Inertia\\scratch")).toBe(false);
    expect(inside("C:\\server\\share\\Inertia\\scratch")).toBe(false);
  });

  it("never treats different folders as the managed folder", () => {
    for (const other of [`${root}2`, `${data}\\scratc`, `D:${root.slice(2)}`, data, "C:\\", `${data}\\scratch-old\\x`]) {
      expect(inside(other), other).toBe(false);
    }
  });
});
