import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RuntimeTestCleanup } from "../support/runtime-test-cleanup";

describe("runtime test cleanup", () => {
  it("retains a failed test's owners and paths without contaminating later cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-test-cleanup-"));
    const failedDirectory = join(root, "failed");
    const nextDirectory = join(root, "next");
    mkdirSync(failedDirectory);
    mkdirSync(nextDirectory);
    const failure = new Error("The owned process tree could not be confirmed stopped.");
    const failedRuntime = { close: vi.fn(async () => { throw failure; }) };
    let finishSibling!: () => void;
    const sibling = new Promise<void>((resolve) => { finishSibling = resolve; });
    const siblingRuntime = { close: vi.fn(() => sibling) };
    const nextRuntime = { close: vi.fn(async () => undefined) };
    const cleanup = new RuntimeTestCleanup();
    cleanup.runtimes.push(failedRuntime, siblingRuntime);
    cleanup.directories.push(failedDirectory);
    let settled = false;
    const closing = cleanup.close().then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(existsSync(failedDirectory)).toBe(true);
      finishSibling();
      expect(await closing).toBe(failure);
      expect(cleanup.quarantined).toEqual([{
        runtimes: [failedRuntime, siblingRuntime],
        directories: [failedDirectory],
        error: failure,
      }]);

      cleanup.runtimes.push(nextRuntime);
      cleanup.directories.push(nextDirectory);
      await cleanup.close();
      expect(nextRuntime.close).toHaveBeenCalledOnce();
      expect(existsSync(nextDirectory)).toBe(false);
      expect(existsSync(failedDirectory)).toBe(true);
      expect(failedRuntime.close).toHaveBeenCalledOnce();
      expect(siblingRuntime.close).toHaveBeenCalledOnce();
      expect(cleanup.quarantined[0]?.runtimes[0]).toBe(failedRuntime);
    } finally {
      finishSibling();
      await closing;
      // These owners are test doubles, so no process can still use the files.
      rmSync(root, { recursive: true, force: true });
    }
  });
});
