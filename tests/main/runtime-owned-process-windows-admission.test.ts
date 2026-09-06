import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmRuntimeOwnedProcessStopped,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedPidProcess,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcess>();
let deactivate: (() => void) | null = null;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-windows-admission-"));
  temporaryDirectories.push(directory);
  return directory;
}

function activate(directory: string): RuntimeOwnedProcessJournal {
  deactivate = activatePreparedRuntimeOwnedProcessRegistry(
    directory,
    runtimeGenerationId,
    systemBootId,
    { platform: "win32" },
  );
  return new RuntimeOwnedProcessJournal(directory, { platform: "win32" });
}

function closeOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

afterEach(async () => {
  const children = [...liveChildren];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(children.map(closeOf));
  liveChildren.clear();
  deactivate?.();
  deactivate = null;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows runtime owned process admission", () => {
  it.each([
    { label: "a zero PID", pid: 0, spawnedAfterMs: 1, spawnedBeforeMs: 2 },
    { label: "an inverted birth window", pid: 4_242, spawnedAfterMs: 2, spawnedBeforeMs: 1 },
    { label: "a non-finite birth window", pid: 4_242, spawnedAfterMs: Number.NaN, spawnedBeforeMs: 2 },
  ])("does not publish $label that its reader would reject", ({
    pid,
    spawnedAfterMs,
    spawnedBeforeMs,
  }) => {
    const directory = temporaryDirectory();
    const journal = new RuntimeOwnedProcessJournal(directory, { platform: "win32" });
    expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
    const ownershipId = journal.begin(
      runtimeGenerationId,
      systemBootId,
      journal.sessionCapability(runtimeGenerationId, systemBootId)!,
    );
    const claimName = readdirSync(directory).find((name) =>
      name.startsWith(".runtime-owned-child-") && name.endsWith(".json"));
    expect(claimName).toBeDefined();
    const pending = readFileSync(join(directory, claimName!));

    expect(() => journal.claim(
      ownershipId,
      runtimeGenerationId,
      systemBootId,
      pid,
      process.pid,
      { spawnedAfterMs, spawnedBeforeMs },
    )).toThrow("The spawned process ownership could not be proven.");

    expect(readFileSync(join(directory, claimName!))).toEqual(pending);
    expect(journal.records(runtimeGenerationId)).toMatchObject([
      { ownershipId, state: "pending" },
    ]);
  });

  it.runIf(process.platform === "win32")(
    "keeps a missing executable pending until Node confirms the failed spawn",
    async () => {
      const directory = temporaryDirectory();
      const journal = activate(directory);
      const child = spawnRuntimeOwnedProcess(() => spawn(
        join(directory, "inertia-missing-owned-process.exe"),
        [],
        { shell: false, stdio: "ignore" },
      ));
      liveChildren.add(child);
      child.once("close", () => liveChildren.delete(child));
      const childError = new Promise<NodeJS.ErrnoException>((resolve) => {
        child.once("error", (error) => resolve(error as NodeJS.ErrnoException));
      });
      const closed = closeOf(child);

      expect(child.pid).toBeUndefined();
      expect(confirmRuntimeOwnedProcessStopped(child)).toBe(false);
      expect(journal.records(runtimeGenerationId)).toMatchObject([
        { state: "pending" },
      ]);

      await expect(childError).resolves.toMatchObject({ code: "ENOENT" });
      await closed;

      expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")(
    "publishes and retires a valid Windows child identity",
    async () => {
      const directory = temporaryDirectory();
      const journal = activate(directory);
      const child = spawnRuntimeOwnedProcess(() => spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
        { shell: false, stdio: "ignore" },
      ));
      liveChildren.add(child);
      child.once("close", () => liveChildren.delete(child));
      const closed = closeOf(child);

      expect(child.pid).toBeGreaterThan(1);
      expect(journal.records(runtimeGenerationId)).toMatchObject([{
        state: "owned",
        process: { platform: "win32", pid: child.pid },
      }]);

      child.kill("SIGTERM");
      await closed;

      expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
    },
  );

  it("keeps a zero-PID owned-object admission readable and never signals PID zero", () => {
    const directory = temporaryDirectory();
    const journal = activate(directory);
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      expect(() => spawnRuntimeOwnedPidProcess(() => ({ pid: 0 })))
        .toThrow("The spawned process ownership could not be proven.");
      expect(processKill).not.toHaveBeenCalled();
      expect(journal.records(runtimeGenerationId)).toMatchObject([
        { state: "pending" },
      ]);
    } finally {
      processKill.mockRestore();
    }
  });
});
