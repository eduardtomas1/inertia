import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";

const bootId = "test:00000000-0000-4000-8000-000000000001";
const priorGeneration = "30000000-0000-4000-8000-000000000003:8";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "runtime supervisor startup recovery",
  () => {
    it("blocks spawning when prior process cleanup remains unconfirmed", async () => {
      const dataDirectory = mkdtempSync(join(tmpdir(), "inertia-startup-recovery-"));
      directories.push(dataDirectory);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory)
        .publish(priorGeneration, bootId)).toBe(true);
      const journal = new RuntimeOwnedProcessJournal(dataDirectory);
      expect(journal.startSession(priorGeneration, bootId)).toBe(true);
      journal.begin(priorGeneration, bootId);
      const spawn = vi.fn(() => new EventEmitter() as never);
      const supervisor = new RuntimeSupervisor({
        systemBootId: bootId,
        workerOptions: {
          dataDirectory,
          defaultWorkspacePath: dataDirectory,
          enableProviders: false,
        },
        spawn,
      });

      supervisor.start();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(spawn).not.toHaveBeenCalled();
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        generation: 0,
        restartScheduled: false,
        lastError: expect.stringContaining("unconfirmed process cleanup"),
      });
      supervisor.start();
      expect(spawn).not.toHaveBeenCalled();
      expect(journal.records(priorGeneration)).toMatchObject([
        { state: "pending" },
      ]);
    });
  },
);
