import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { writeDatabaseRecoveryExportFile } from "../../src/server/persistence/database-export-file";
import {
  BoundedDatabaseRecoveryReceipts,
  DatabaseRecoveryOperationQueue,
} from "../../src/server/runtime/database-recovery-queue";

describe("database recovery operation serialization", () => {
  it("retains bounded authoritative terminal receipts for cancellation races", () => {
    const receipts = new BoundedDatabaseRecoveryReceipts<{
      operation: "export" | "import";
      outcome: string;
    }>(2);
    receipts.record("1:first", { operation: "import", outcome: "committed" });
    receipts.record("1:second", { operation: "export", outcome: "published" });
    expect(receipts.find("1:first", "import"))
      .toEqual({ operation: "import", outcome: "committed" });
    expect(receipts.find("1:first", "export")).toBeNull();
    expect(receipts.has("1:first")).toBe(true);
    receipts.record("1:third", { operation: "export", outcome: "cancelled" });
    expect(receipts.find("1:first", "import")).toBeNull();
    expect(receipts.has("1:first")).toBe(false);
    expect(receipts.find("1:second", "export")?.outcome).toBe("published");
  });

  it("does not overlap imports/exports and continues after a failed operation", async () => {
    const queue = new DatabaseRecoveryOperationQueue();
    expect(queue.hasActiveOperations()).toBe(false);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.enqueue("first", async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
      throw new Error("injected failure");
    });
    const second = queue.enqueue("second", async () => {
      events.push("second:start");
      events.push("second:end");
      return "complete";
    });
    await Promise.resolve();
    expect(queue.hasActiveOperations()).toBe(true);
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("injected failure");
    await expect(second).resolves.toBe("complete");
    expect(queue.hasActiveOperations()).toBe(false);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("removes cancelled queued operations immediately behind an occupied slot", async () => {
    const queue = new DatabaseRecoveryOperationQueue();
    let releaseActive!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseActive = resolve; });
    const active = queue.enqueue("active", async () => blocked);
    const queued = Array.from({ length: 256 }, (_, index) => {
      const retainedAttachment = Buffer.alloc(64 * 1_024, index);
      return queue.enqueue(
        `queued-${index}`,
        async () => retainedAttachment,
      ).then(
        () => null,
        (error: unknown) => error,
      );
    });
    await Promise.resolve();

    for (let index = 0; index < queued.length; index += 1) {
      expect(queue.cancel(`queued-${index}`)).toBe(true);
    }
    for (const result of await Promise.all(queued)) {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/cancelled/u);
    }
    releaseActive();
    await expect(active).resolves.toBeUndefined();
    await queue.closeAndDrain();
  });

  it("confirms running cancellation before starting a serialized retry", async () => {
    const queue = new DatabaseRecoveryOperationQueue();
    const events: string[] = [];
    const running = queue.enqueue("running", async (signal) => {
      events.push("running:start");
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await Promise.resolve();
    const retry = queue.enqueue("retry", async () => {
      events.push("retry:start");
      return "retried";
    });
    expect(queue.cancel("running")).toBe(true);
    await expect(running).rejects.toThrow(/cancelled/u);
    await expect(retry).resolves.toBe("retried");
    expect(events).toEqual(["running:start", "retry:start"]);
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
      const active = queue.enqueue("active", (signal) => writeDatabaseRecoveryExportFile(
        join(directory, "recovery.json"),
        "transcript content",
        { signal, operations: { open: injectedOpen } },
      ));
      const queued = queue.enqueue("queued", async () => "must not start");
      const activeResult = active.then(
        () => null,
        (error: unknown) => error,
      );
      const queuedResult = queued.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(
        readdirSync(directory).some((entry) => entry.endsWith(".partial")),
      ).toBe(true));

      await queue.closeAndDrain();

      const activeError = await activeResult;
      const queuedError = await queuedResult;
      expect(activeError).toBeInstanceOf(Error);
      expect(queuedError).toBeInstanceOf(Error);
      expect((queuedError as Error).message).toMatch(/cancelled/u);
      expect(readdirSync(directory)).toEqual([]);
      await expect(queue.enqueue("late", async () => "late"))
        .rejects.toThrow(/cancelled/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
