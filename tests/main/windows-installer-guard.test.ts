import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getMakeNsisPath } from "app-builder-lib/out/toolsets/windows";
import { expect, test } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../..");

test.runIf(process.platform === "win32")(
  "the compiled NSIS guard preserves live processes and accepts a drained root under Restricted policy",
  async () => {
    const { runBounded, BoundedProcessExitError } = await import(pathToFileURL(
      join(repositoryRoot, "scripts/bounded-process-tree.mjs"),
    ).href);
    const root = await mkdtemp(join(tmpdir(), "inertia-native-installer-guard-"));
    const installDirectory = join(root, "installed with spaces");
    const siblingDirectory = `${installDirectory}-sibling`;
    const fixture = join(root, "guard.exe");
    const children: ChildProcess[] = [];
    try {
      await Promise.all([mkdir(installDirectory), mkdir(siblingDirectory)]);
      const compiler = await getMakeNsisPath(undefined);
      await runBounded(compiler.path, [
        "/V2", join(repositoryRoot, "tests/fixtures/windows-installer-guard.nsi"),
      ], {
        label: "Compile the actual NSIS install-root guard",
        env: {
          ...process.env,
          ...compiler.env,
          INERTIA_GUARD_FIXTURE_OUTPUT: fixture,
        },
        timeoutMs: 30_000,
      });
      const runGuard = async (expectedCode: number, installRoot = installDirectory) => {
        let exitCode = 0;
        try {
          await runBounded(fixture, ["/S"], {
            label: `Compiled NSIS guard: expected exit ${expectedCode}`,
            env: {
              ...process.env,
              INERTIA_GUARD_FIXTURE_ROOT: installRoot,
              PSExecutionPolicyPreference: "Restricted",
            },
            timeoutMs: 20_000,
          });
        } catch (error) {
          if (!(error instanceof BoundedProcessExitError)
            || !(error instanceof Error) || !("exitCode" in error)
            || typeof error.exitCode !== "number") throw error;
          exitCode = error.exitCode;
        }
        expect(exitCode).toBe(expectedCode);
      };
      for (const directory of [installDirectory, siblingDirectory]) {
        const executable = join(directory, "blocker.exe");
        await copyFile(process.execPath, executable);
        const child = spawn(executable, ["-e", "process.stdin.resume()"], {
          stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
        });
        children.push(child);
        await once(child, "spawn");
      }
      await runGuard(1);
      expect(children.every((child) => child.exitCode === null)).toBe(true);
      const ownedClosed = once(children[0], "close");
      children[0].stdin?.end();
      await ownedClosed;
      await runGuard(0);
      expect(children[1].exitCode).toBeNull();
      await runGuard(0, join(root, "fresh destination"));
      await runGuard(2, fixture);
      expect(children[1].exitCode).toBeNull();
    } finally {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, "close");
        child.stdin?.end();
        const fallback = setTimeout(() => child.kill(), 5_000);
        try { await closed; } finally { clearTimeout(fallback); }
      }));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  90_000,
);
