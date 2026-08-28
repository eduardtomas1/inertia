import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  activateRuntimeOwnedProcessRegistry,
  confirmRuntimeOwnedProcessStopped,
  darwinProcessGuardianReady,
  runtimeOwnedProcessInvocation,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcess>();
const deactivators: Array<() => void> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-owned-process-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function activate(directory: string): void {
  const deactivate = activateRuntimeOwnedProcessRegistry(
    directory,
    runtimeGenerationId,
    systemBootId,
    {
      darwinGuardianPath: join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      ),
    },
  );
  if (deactivate) deactivators.push(deactivate);
}

function closeOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ESRCH"
    );
  }
}

afterEach(async () => {
  while (deactivators.length > 0) deactivators.pop()?.();
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
    }
  }
  await Promise.all([...liveChildren].map(closeOf));
  liveChildren.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("macOS runtime process guardian", () => {
  it.runIf(process.platform === "darwin")(
    "does not census the full machine while no-fork payloads run",
    async () => {
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      const guardians: ChildProcess[] = [];
      for (let index = 0; index < 12; index += 1) {
        const guardian = spawn(guardianPath, [
          "watch",
          String(process.pid),
          "--",
          "/bin/sleep",
          "8",
        ], { detached: true, shell: false, stdio: "ignore" });
        liveChildren.add(guardian);
        guardian.once("close", () => liveChildren.delete(guardian));
        guardians.push(guardian);
        const guardianPid = guardian.pid ?? 0;
        expect(guardianPid).toBeGreaterThan(1);
        await expect.poll(
          () => darwinProcessGuardianReady(guardianPid, guardianPath)?.pid ?? 0,
          { timeout: 5_000 },
        ).toBe(guardianPid);
        process.kill(guardianPid, "SIGUSR1");
      }

      const sampleCpuSeconds = (): number => {
        for (const guardian of guardians) {
          expect(guardian.exitCode).toBeNull();
          expect(guardian.signalCode).toBeNull();
        }
        const sampled = spawnSync(
          "/bin/ps",
          [
            "-o",
            "time=",
            "-p",
            guardians.map((guardian) => String(guardian.pid)).join(","),
          ],
          { encoding: "utf8", shell: false, timeout: 5_000 },
        );
        expect(sampled.status, `${sampled.stderr}\n${sampled.stdout}`).toBe(0);
        const elapsedRows = sampled.stdout.split("\n")
          .map((elapsed) => elapsed.trim())
          .filter((elapsed) => elapsed.length > 0);
        expect(elapsedRows).toHaveLength(guardians.length);
        return elapsedRows.reduce((total, elapsed) => {
          const [minutes, seconds] = elapsed.split(":").map(Number);
          expect(minutes).toBeGreaterThanOrEqual(0);
          expect(seconds).toBeGreaterThanOrEqual(0);
          return total + (minutes! * 60) + seconds!;
        }, 0);
      };

      try {
        // Exclude the intentionally expensive one-time admission censuses.
        // During the idle interval the former 50 Hz PROC_ALL_PIDS loop burns
        // well over this budget with the same realistic burst.
        const baselineCpuSeconds = sampleCpuSeconds();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const idleCpuSeconds = sampleCpuSeconds() - baselineCpuSeconds;
        expect(idleCpuSeconds).toBeGreaterThanOrEqual(0);
        expect(idleCpuSeconds).toBeLessThan(0.25);
      } finally {
        for (const guardian of guardians) {
          if (guardian.exitCode === null && guardian.signalCode === null) {
            guardian.kill("SIGTERM");
          }
        }
        await Promise.all(guardians.map((guardian) => closeOf(guardian)));
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "resumes a killed stopped Node readline payload before retiring its guardian",
    async () => {
      const directory = temporaryDirectory();
      const payloadPidPath = join(directory, "readline-payload.pid");
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      activate(directory);
      const source = [
        "const { writeFileSync } = require('node:fs')",
        "const { createInterface } = require('node:readline')",
        `writeFileSync(${JSON.stringify(payloadPidPath)}, String(process.pid))`,
        "createInterface({ input: process.stdin })",
        "setInterval(() => undefined, 1000)",
      ].join(";");
      const invocation = runtimeOwnedProcessInvocation(
        process.execPath,
        ["-e", source],
      );
      const guardian = spawnRuntimeOwnedProcess(() => spawn(
        invocation.command,
        invocation.args,
        { detached: true, shell: false, stdio: ["pipe", "ignore", "ignore"] },
      ));
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));

      let payloadPid = 0;
      await expect.poll(() => {
        if (existsSync(payloadPidPath)) {
          payloadPid = Number(readFileSync(payloadPidPath, "utf8").trim());
        }
        return Number.isSafeInteger(payloadPid) && payloadPid > 1;
      }, { timeout: 5_000 }).toBe(true);
      expect(processIsAlive(payloadPid)).toBe(true);

      guardian.kill("SIGTERM");
      await closeOf(guardian);

      expect(guardian.exitCode).toBe(137);
      expect(guardian.signalCode).toBeNull();
      expect(processIsAlive(payloadPid)).toBe(false);
      await expect.poll(() => new RuntimeOwnedProcessJournal(directory, {
        platform: "darwin",
        darwinGuardianPath: guardianPath,
      }).records(runtimeGenerationId)).toEqual([]);
      expect(confirmRuntimeOwnedProcessStopped(guardian)).toBe(true);
    },
    15_000,
  );
});
