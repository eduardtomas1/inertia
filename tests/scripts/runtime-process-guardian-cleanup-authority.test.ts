import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireGuardianBuildLock,
  reclaimStaleGuardianBuildLock,
  releaseGuardianBuildLock,
} from "../../scripts/runtime-process-guardian-publication.mjs";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-guardian-authority-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory);
  return stateDirectory;
}

function writeSyntheticLock(
  stateDirectory: string,
  token: string,
): void {
  const expiresAtMs = Date.now() - 1;
  const owner = join(stateDirectory, `owner-${token}`);
  writeFileSync(owner, JSON.stringify({
    createdAtMs: expiresAtMs - 1_000,
    expiresAtMs,
    pid: 2_147_483_647,
    processIdentity: null,
    token,
    version: 1,
  }));
  linkSync(owner, join(stateDirectory, "build.lock"));
}

function writeAgedAuthority(
  stateDirectory: string,
  token: string,
  authority: {
    readonly pid: number;
    readonly processGroupId: number | null;
    readonly processIdentity: string | null;
  },
): string {
  const path = join(stateDirectory, `child-${token}.json`);
  writeFileSync(path, JSON.stringify({
    ...authority,
    state: "cleanup-unconfirmed",
    token,
    version: 1,
  }));
  const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
  utimesSync(path, aged, aged);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("cleanup-unconfirmed guardian authority", () => {
  it("preserves an aged authority with its exact live birth identity", () => {
    const stateDirectory = fixture();
    const probe = acquireGuardianBuildLock(stateDirectory);
    const processIdentity = JSON.parse(readFileSync(probe.lockPath, "utf8"))
      .processIdentity as string;
    releaseGuardianBuildLock(probe);
    const token = "19191919-1919-4919-8919-191919191919";
    writeSyntheticLock(stateDirectory, token);
    writeAgedAuthority(stateDirectory, token, {
      pid: process.pid,
      processGroupId: null,
      processIdentity,
    });

    expect(() =>
      acquireGuardianBuildLock(stateDirectory, { timeoutMs: 40 }),
    ).toThrow("Timed out waiting");
  });

  it.skipIf(process.platform === "win32")(
    "preserves aged authority while its POSIX process group is live",
    async () => {
      const stateDirectory = fixture();
      const token = "20202020-2020-4020-8020-202020202020";
      writeSyntheticLock(stateDirectory, token);
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      if (!child.pid)
        throw new Error("The test-owned process group did not start.");
      writeAgedAuthority(stateDirectory, token, {
        pid: 2_147_483_647,
        processGroupId: child.pid,
        processIdentity: null,
      });
      try {
        expect(() =>
          acquireGuardianBuildLock(stateDirectory, { timeoutMs: 40 }),
        ).toThrow("Timed out waiting");
      } finally {
        process.kill(-child.pid, "SIGKILL");
        await new Promise<void>((resolveExit) =>
          child.once("exit", () => resolveExit()),
        );
      }
      const lock = acquireGuardianBuildLock(stateDirectory, { timeoutMs: 200 });
      releaseGuardianBuildLock(lock);
      expect(readdirSync(stateDirectory)).toEqual([]);
    },
  );

  it("never ages out valid cleanup-unconfirmed Windows Job authority", () => {
    const stateDirectory = fixture();
    const token = "21212121-2121-4121-8121-212121212121";
    writeSyntheticLock(stateDirectory, token);
    const authorityPath = writeAgedAuthority(stateDirectory, token, {
      pid: 2_147_483_647,
      processGroupId: null,
      processIdentity: "win32:638923680000000000",
    });

    expect(reclaimStaleGuardianBuildLock(
      stateDirectory,
      join(stateDirectory, "build.lock"),
      { testAuthorityPlatform: "win32" },
    )).toBe(false);
    expect(existsSync(join(stateDirectory, "build.lock"))).toBe(true);
    expect(existsSync(authorityPath)).toBe(true);
  });
});
