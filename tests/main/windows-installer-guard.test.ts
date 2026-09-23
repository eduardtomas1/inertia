import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getMakeNsisPath } from "app-builder-lib/out/toolsets/windows";
import { expect, test } from "vitest";

import { createInstallerGuardTrace, reportInstallerGuardFailure } from "../helpers/windows-installer-guard-diagnostic";

const repositoryRoot = join(import.meta.dirname, "../..");

test.runIf(process.platform === "win32").for(["inherited", "external-only"] as const)(
  "the compiled NSIS guard preserves live processes under Restricted policy with %s modules",
  { timeout: 90_000 },
  async (modulePaths, { onTestFailed }) => {
    const trace = createInstallerGuardTrace(modulePaths);
    const { runBounded, BoundedProcessExitError } = await import(pathToFileURL(
      join(repositoryRoot, "scripts/bounded-process-tree.mjs"),
    ).href);
    const root = await mkdtemp(join(tmpdir(), "inertia-native-installer-guard-"));
    const installDirectory = join(root, "installed with spaces");
    const siblingDirectory = `${installDirectory}-sibling`;
    const fixture = join(root, "guard.exe");
    const externalModules = join(root, "external modules");
    // Node keeps only one spelling of a Windows environment key. Remove every
    // inherited spelling before supplying the deliberate external-only path.
    const externalModuleEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
    );
    const children: ChildProcess[] = [];
    const queryResults: Array<{
      expectedCode: number;
      exitCode: number | null;
      elapsedMs: number;
      queryResult: string;
      powerShellPath: string;
    }> = [];
    onTestFailed(async () => await reportInstallerGuardFailure(trace, root, children, queryResults));
    try {
      await trace.step("directories", async () =>
        await Promise.all([mkdir(installDirectory), mkdir(siblingDirectory), mkdir(externalModules)]));
      const compiler = await trace.step("compiler-lookup", async () => await getMakeNsisPath(undefined));
      await trace.step("compilation", async () => await runBounded(compiler.path, [
        "/V2", join(repositoryRoot, "tests/fixtures/windows-installer-guard.nsi"),
      ], {
        label: "Compile the actual NSIS install-root guard",
        env: {
          ...process.env,
          ...compiler.env,
          INERTIA_GUARD_FIXTURE_OUTPUT: fixture,
          INERTIA_GUARD_FIXTURE_INCLUDE: join(repositoryRoot, "resources/installer.nsh"),
        },
        onSpawn: ({ pid }: { pid?: number }) => trace.spawned(pid),
        timeoutMs: 30_000,
      }));
      const runGuard = async (expectedCode: number, installRoot = installDirectory,
        rootCategory: "installed" | "fresh" | "unsafe-file" = "installed") => {
        const context = { probe: { index: queryResults.length, expectedCode, root: rootCategory } };
        let exitCode: number | null = null;
        const queryResultPath = join(root, `query-result-${queryResults.length}.txt`);
        const startedAt = performance.now();
        try {
          await trace.step("guard", async () => await runBounded(fixture, ["/S"], {
            label: `Compiled NSIS guard: expected exit ${expectedCode}`,
            env: {
              ...(modulePaths === "external-only" ? externalModuleEnvironment : process.env),
              INERTIA_GUARD_FIXTURE_ROOT: installRoot,
              INERTIA_GUARD_FIXTURE_QUERY_RESULT: queryResultPath,
              PSExecutionPolicyPreference: "Restricted",
              ...(modulePaths === "external-only" ? { PSModulePath: externalModules } : {}),
            },
            onSpawn: ({ pid }: { pid?: number }) => trace.spawned(pid),
            timeoutMs: 20_000,
          }), context);
          exitCode = 0;
        } catch (error) {
          if (!(error instanceof BoundedProcessExitError)
            || !(error instanceof Error) || !("exitCode" in error)
            || typeof error.exitCode !== "number") throw error;
          exitCode = error.exitCode;
        } finally {
          const [queryResult = "result-not-recorded", powerShellPath = ""] = (
            await trace.step("query-read", async () =>
              await readFile(queryResultPath, "utf8").catch(() => "result-not-recorded"), context)
          ).split(/\r?\n/u);
          queryResults.push({
            expectedCode,
            exitCode,
            elapsedMs: Math.round(performance.now() - startedAt),
            queryResult: queryResult.slice(0, 128),
            powerShellPath: powerShellPath.slice(0, 1024),
          });
        }
        trace.check("guard-assertions", () => {
          expect(exitCode).toBe(expectedCode);
          if (process.arch === "x64" || process.arch === "arm64") {
            expect(queryResults.at(-1)?.powerShellPath)
              .toMatch(/\\Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
          }
        }, context);
      };
      for (const [blockerIndex, directory] of [installDirectory, siblingDirectory].entries()) {
        const executable = join(directory, "blocker.exe");
        await trace.step("blocker-copy", async () => await copyFile(process.execPath, executable), { blockerIndex });
        await trace.step("blocker-spawn", async () => {
          const child = spawn(executable, ["-e", "process.stdin.resume()"], {
            stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
          });
          children.push(child);
          child.once("close", () => trace.check("blocker-close", () => undefined, { blockerIndex }));
          await once(child, "spawn");
        }, { blockerIndex });
      }
      await runGuard(1);
      trace.check("blocker-assertions", () => expect(children.every((child) => child.exitCode === null)).toBe(true));
      await trace.step("installed-blocker-close", async () => {
        const ownedClosed = once(children[0], "close");
        children[0].stdin?.end();
        await ownedClosed;
      });
      await runGuard(0);
      trace.check("blocker-assertions", () => expect(children[1].exitCode).toBeNull());
      await runGuard(0, join(root, "fresh destination"), "fresh");
      await runGuard(2, fixture, "unsafe-file");
      trace.check("blocker-assertions", () => expect(children[1].exitCode).toBeNull());
    } finally {
      await trace.step("blocker-cleanup", async () => await Promise.all(children.map(async (child, blockerIndex) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, "close");
        child.stdin?.end();
        const fallback = setTimeout(() => trace.check("blocker-kill", () => child.kill(), { blockerIndex }), 5_000);
        try { await closed; } finally { clearTimeout(fallback); }
      })));
      await trace.step("root-removal", async () =>
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    }
  },
);
