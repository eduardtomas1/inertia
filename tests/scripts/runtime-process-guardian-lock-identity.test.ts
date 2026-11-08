import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const identities = vi.hoisted(() => new Map<string, bigint>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((path: fs.PathLike, options?: fs.StatSyncOptions) => {
    const stats = actual.lstatSync(path, options);
    const ino = identities.get(String(path));
    if (!stats || ino === undefined) return stats;
    const copy = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats);
    return Object.assign(copy, options?.bigint
      ? { dev: 7n, ino }
      : { dev: 7, ino: Number(ino) });
  }) as typeof actual.lstatSync;
  return { ...actual, default: { ...actual, lstatSync }, lstatSync };
});

const {
  beginGuardianBuildChildLaunch,
  releaseGuardianBuildLock,
} = await import("../../scripts/runtime-process-guardian-publication.mjs");

const roots: string[] = [];
const TOKEN = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  identities.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function replacedLock(fixedIno: bigint, ownerIno: bigint) {
  const stateDirectory = mkdtempSync(join(tmpdir(), "inertia-guardian-identity-"));
  roots.push(stateDirectory);
  const lockPath = join(stateDirectory, "build.lock");
  const ownerPath = join(stateDirectory, `owner-${TOKEN}`);
  const record = JSON.stringify({ token: TOKEN, version: 1 });
  writeFileSync(lockPath, record);
  writeFileSync(ownerPath, record);
  identities.set(lockPath, fixedIno);
  identities.set(ownerPath, ownerIno);
  return { lockPath, ownerPath, token: TOKEN, heartbeat: null };
}

describe("runtime guardian build lock identity above 2^53", () => {
  const fixedIno = 2n ** 53n;
  const replacementIno = 2n ** 53n + 1n;

  it("does not mistake a replaced lock for its own when inode numbers round together", () => {
    expect(Number(fixedIno)).toBe(Number(replacementIno));
    const lock = replacedLock(fixedIno, replacementIno);
    expect(() => beginGuardianBuildChildLaunch(lock)).toThrow("The runtime guardian build lock was replaced.");
    releaseGuardianBuildLock(lock);
    expect(fs.existsSync(lock.lockPath)).toBe(true);
  });

  it("still releases its own lock at the same large inode", () => {
    const lock = replacedLock(fixedIno, fixedIno);
    expect(() => beginGuardianBuildChildLaunch(lock)).not.toThrow();
    releaseGuardianBuildLock(lock);
    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });
});
