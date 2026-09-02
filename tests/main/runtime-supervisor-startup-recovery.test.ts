import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import {
  pinDirectRuntimeJournalChildRoot,
  pinDirectRuntimeJournalRoot,
  removeDirectRuntimeJournalChildRoot,
} from "../../src/node/direct-runtime-journal";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { runtimeOwnedProcessWriterName } from
  "../../src/node/runtime-owned-process-session-journal";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";

const bootId = "test:00000000-0000-4000-8000-000000000001";
const priorGeneration = "30000000-0000-4000-8000-000000000003:8";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime supervisor startup recovery", () => {
  it(
    "repairs a missing stale-session writer before spawning its replacement",
    async () => {
      const dataDirectory = mkdtempSync(join(tmpdir(), "inertia-startup-recovery-"));
      directories.push(dataDirectory);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory)
        .publish(priorGeneration, bootId)).toBe(true);
      expect(new RuntimeOwnedProcessJournal(dataDirectory)
        .startSession(priorGeneration, bootId)).toBe(true);
      const root = pinDirectRuntimeJournalRoot(dataDirectory);
      const writerName = runtimeOwnedProcessWriterName(priorGeneration);
      const writer = pinDirectRuntimeJournalChildRoot(root, writerName);
      expect(writer).not.toBeNull();
      expect(removeDirectRuntimeJournalChildRoot(
        root,
        writerName,
        writer!,
      )).toBe(true);
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

      expect(spawn).toHaveBeenCalledOnce();
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .toHaveLength(1);
      expect(new RuntimeOwnedProcessJournal(dataDirectory)
        .sessionExact(priorGeneration)).toBeNull();
    },
  );

  it("blocks spawning when prior process cleanup remains unconfirmed", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inertia-startup-recovery-"));
    directories.push(dataDirectory);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory)
      .publish(priorGeneration, bootId)).toBe(true);
    const journal = new RuntimeOwnedProcessJournal(dataDirectory);
    expect(journal.startSession(priorGeneration, bootId)).toBe(true);
    journal.begin(
      priorGeneration,
      bootId,
      journal.sessionCapability(priorGeneration, bootId)!,
    );
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
});
