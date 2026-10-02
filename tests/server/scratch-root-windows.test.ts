import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWithinScratchRoot } from "../../src/server/scratch-root";

const windows = vi.hoisted(() => ({ zeroIdentity: false, aliases: new Map<string, string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const native = ((path: fs.PathLike, options?: never) => {
    const target = windows.aliases.get(String(path)) ?? String(path);
    return actual.realpathSync.native(target, options);
  }) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(
    ((path: fs.PathLike, options?: never) => actual.realpathSync(path, options)) as typeof actual.realpathSync,
    { native },
  );
  const statSync = ((path: fs.PathLike, options?: never) => {
    const stats = actual.statSync(windows.aliases.get(String(path)) ?? path, options) as fs.BigIntStats;
    if (windows.zeroIdentity) {
      stats.dev = 0n;
      stats.ino = 0n;
    }
    return stats;
  }) as typeof actual.statSync;
  const overrides = { realpathSync, statSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

let data: string;
let elsewhere: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  data = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "inertia-scratch-root-windows-")));
  fs.mkdirSync(join(data, "scratch", "2026-10-02-plan-11111111-1111-4111-8111-111111111111"), { recursive: true });
  elsewhere = join(data, "user-project");
  fs.mkdirSync(elsewhere);
  windows.zeroIdentity = false;
  windows.aliases.clear();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  fs.rmSync(data, { recursive: true, force: true });
});

describe("managed folder containment with Windows file identities", () => {
  it("does not treat every folder as the managed folder when the file system reports no file identity", () => {
    windows.zeroIdentity = true;
    expect(isWithinScratchRoot(data, elsewhere)).toBe(false);
    expect(isWithinScratchRoot(data, data)).toBe(false);
    expect(isWithinScratchRoot(data, join(data, "scratch"))).toBe(true);
    expect(isWithinScratchRoot(data, join(data, "scratch", "2026-10-02-plan-11111111-1111-4111-8111-111111111111"))).toBe(true);
  });

  it("matches a differently cased Windows spelling of the managed folder by path when identities are missing", () => {
    windows.zeroIdentity = true;
    const cased = join(data, "SCRATCH");
    windows.aliases.set(cased, join(data, "scratch"));
    expect(isWithinScratchRoot(data, cased)).toBe(true);
  });

  it("matches a short name by identity when the file system reports one", () => {
    const shortName = join(data, "SCRATC~1");
    windows.aliases.set(shortName, join(data, "scratch"));
    expect(isWithinScratchRoot(data, shortName)).toBe(true);
    expect(isWithinScratchRoot(data, elsewhere)).toBe(false);
  });
});
