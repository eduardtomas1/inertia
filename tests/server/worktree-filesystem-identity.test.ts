import { describe, expect, it } from "vitest";

import {
  isWorktreeFilesystemIdentity,
  worktreeFilesystemIdentitiesEqual,
} from "../../src/server/worktree-filesystem-identity";

describe("worktree filesystem identity", () => {
  it("accepts a directory whose filesystem reports no birth time", () => {
    expect(isWorktreeFilesystemIdentity({ device: "64769", inode: "1310722", birthtimeNs: "0" })).toBe(true);
    expect(isWorktreeFilesystemIdentity({ device: "0", inode: "1310722", birthtimeNs: "0" })).toBe(false);
    expect(isWorktreeFilesystemIdentity({ device: "64769", inode: "0", birthtimeNs: "0" })).toBe(false);
    expect(isWorktreeFilesystemIdentity({ device: "64769", inode: "1310722", birthtimeNs: "-1" })).toBe(false);
  });

  it("compares birth times only when both sides report one", () => {
    const base = { device: "64769", inode: "1310722" };
    expect(worktreeFilesystemIdentitiesEqual({ ...base, birthtimeNs: "0" }, { ...base, birthtimeNs: "1700000000000000000" })).toBe(true);
    expect(worktreeFilesystemIdentitiesEqual({ ...base, birthtimeNs: "0" }, { ...base, birthtimeNs: "0" })).toBe(true);
    expect(worktreeFilesystemIdentitiesEqual(
      { ...base, birthtimeNs: "1700000000000000000" },
      { ...base, birthtimeNs: "1700000000000000001" },
    )).toBe(false);
    expect(worktreeFilesystemIdentitiesEqual({ ...base, birthtimeNs: "0" }, { ...base, inode: "1310723", birthtimeNs: "0" })).toBe(false);
  });
});
