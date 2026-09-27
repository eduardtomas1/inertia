import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awaitRuntimeOwnedProcessCleanupConfirmed,
  confirmRuntimeOwnedProcessStopped,
  runtimeOwnedProcessOwnershipIsTainted,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { createOwnedProcessTreeTermination } from "../../src/server/process-lifecycle";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const systemBootId = "test:61000000-0000-4000-8000-000000000061";
const runtimeGenerationId = "62000000-0000-4000-8000-000000000062:1";
const directories: string[] = [];
let deactivate: (() => void) | null = null;

afterEach(() => {
  deactivate?.();
  deactivate = null;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(["darwin", "linux", "win32"] as const)("%s runtime process ownership", (platform) => {
  it.skipIf(platform === "linux" && process.platform !== "linux")(
    "retires a failed spawn without tainting runtime process ownership",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "inertia-owned-spawn-failure-"));
      directories.push(directory);
      const onTainted = vi.fn();
      deactivate = activatePreparedRuntimeOwnedProcessRegistry(
        directory,
        runtimeGenerationId,
        systemBootId,
        {
          platform,
          ...(platform === "win32" ? {} : { darwinGuardianPath: process.execPath }),
          onTainted,
        },
      );
      const child: ChildProcess = spawnRuntimeOwnedProcess(() => spawn(
        process.execPath,
        ["-e", ""],
        {
          cwd: join(directory, "deleted-worktree"),
          detached: platform !== "win32",
          shell: false,
          stdio: "pipe",
        },
      ));
      expect(child.pid).toBeUndefined();
      const terminate = createOwnedProcessTreeTermination(child, "Owned process tree");
      const failed = new Promise<{ code: string | undefined; stopped: Promise<void> }>((resolve) => {
        child.once("error", (error: NodeJS.ErrnoException) => {
          resolve({ code: error.code, stopped: terminate(false) });
        });
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

      const { code, stopped } = await failed;
      expect(code).toBe("ENOENT");
      await expect(stopped).resolves.toBeUndefined();
      await closed;

      expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
      await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
      expect(onTainted).not.toHaveBeenCalled();
    },
  );
});
