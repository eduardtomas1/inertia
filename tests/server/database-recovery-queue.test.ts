import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { writeDatabaseRecoveryExportFile } from "../../src/server/persistence/database-export-file";
import { DatabaseRecoveryOperationQueue } from "../../src/server/runtime/database-recovery-queue";

describe("database recovery operation serialization", () => {
  it("does not overlap imports/exports and continues after a failed operation", async () => {
    const queue = new DatabaseRecoveryOperationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
      throw new Error("injected failure");
    });
    const second = queue.enqueue(async () => {
      events.push("second:start");
      events.push("second:end");
      return "complete";
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("injected failure");
    await expect(second).resolves.toBe("complete");
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("cancels and drains an active external export without retaining a partial", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-recovery-queue-"));
    const queue = new DatabaseRecoveryOperationQueue();
    const injectedOpen = (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property !== "writeFile") {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (
            _content: string,
            options?: { signal?: AbortSignal },
          ) => new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(options.signal!.reason),
              { once: true },
            );
          });
        },
      });
    }) as typeof open;
    try {
      const active = queue.enqueue((signal) => writeDatabaseRecoveryExportFile(
        join(directory, "recovery.json"),
        "transcript content",
        { signal, operations: { open: injectedOpen } },
      ));
      const queued = queue.enqueue(async () => "must not start");
      await vi.waitFor(() => expect(
        readdirSync(directory).some((entry) => entry.endsWith(".partial")),
      ).toBe(true));

      await queue.closeAndDrain();

      await expect(active).rejects.toThrow(/cancelled during runtime shutdown/u);
      await expect(queued).rejects.toThrow(/cancelled during runtime shutdown/u);
      expect(readdirSync(directory)).toEqual([]);
      await expect(queue.enqueue(async () => "late"))
        .rejects.toThrow(/cancelled during runtime shutdown/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
