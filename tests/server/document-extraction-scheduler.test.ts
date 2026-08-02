import { describe, expect, it } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import {
  documentAttachmentContexts,
} from "../../src/server/runtime/attachments/document-attachment-context";
import {
  DocumentExtractionBudgetError,
  DocumentExtractionCancelledError,
  DocumentExtractionDeadlineError,
  DocumentExtractionScheduler,
} from "../../src/server/runtime/attachments/document-extraction-scheduler";

interface ControlledOperation {
  promise: Promise<string>;
  resolve: () => void;
}

function controlled(
  label: string,
  starts: string[],
): (signal: AbortSignal) => Promise<string> {
  return (signal) => {
    starts.push(label);
    return new Promise<string>((resolve, reject) => {
      operations.push({
        promise: Promise.resolve(label),
        resolve: () => resolve(label),
      });
      signal.addEventListener("abort", () => {
        reject(new DocumentExtractionCancelledError());
      }, { once: true });
    });
  };
}

const operations: ControlledOperation[] = [];

function attachment(index: number, name: string): ChatAttachment {
  return {
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    name,
    path: `/private/${name}`,
    mimeType: "text/plain",
    size: 1,
  };
}

describe("document extraction scheduling", () => {
  it("round-robins waiting turns instead of letting one turn monopolize the queue", async () => {
    operations.length = 0;
    const starts: string[] = [];
    const scheduler = new DocumentExtractionScheduler({ concurrency: 1 });
    const deadlineAt = Date.now() + 5_000;
    const a1 = scheduler.schedule({
      groupId: "turn-a",
      weight: 1,
      deadlineAt,
      operation: controlled("a1", starts),
    });
    const a2 = scheduler.schedule({
      groupId: "turn-a",
      weight: 1,
      deadlineAt,
      operation: controlled("a2", starts),
    });
    const b1 = scheduler.schedule({
      groupId: "turn-b",
      weight: 1,
      deadlineAt,
      operation: controlled("b1", starts),
    });
    expect(starts).toEqual(["a1"]);
    operations[0]!.resolve();
    await a1;
    await Promise.resolve();
    expect(starts).toEqual(["a1", "b1"]);
    operations[1]!.resolve();
    await b1;
    await Promise.resolve();
    expect(starts).toEqual(["a1", "b1", "a2"]);
    operations[2]!.resolve();
    await a2;
  });

  it("enforces concurrency and aggregate working-byte caps", async () => {
    operations.length = 0;
    const starts: string[] = [];
    const scheduler = new DocumentExtractionScheduler({
      concurrency: 2,
      maximumWorkingBytes: 6,
    });
    const deadlineAt = Date.now() + 5_000;
    const largeOne = scheduler.schedule({
      groupId: "turn-a",
      weight: 4,
      deadlineAt,
      operation: controlled("large-one", starts),
    });
    const largeTwo = scheduler.schedule({
      groupId: "turn-a",
      weight: 4,
      deadlineAt,
      operation: controlled("large-two", starts),
    });
    const small = scheduler.schedule({
      groupId: "turn-b",
      weight: 2,
      deadlineAt,
      operation: controlled("small", starts),
    });
    expect(starts).toEqual(["large-one", "small"]);
    operations[1]!.resolve();
    await small;
    await Promise.resolve();
    expect(starts).toEqual(["large-one", "small"]);
    operations[0]!.resolve();
    await largeOne;
    await Promise.resolve();
    expect(starts).toEqual(["large-one", "small", "large-two"]);
    operations[2]!.resolve();
    await largeTwo;

    await expect(scheduler.schedule({
      groupId: "oversized",
      weight: 7,
      deadlineAt,
      operation: controlled("must-not-exceed-budget", starts),
    })).rejects.toBeInstanceOf(DocumentExtractionBudgetError);
    expect(starts).not.toContain("must-not-exceed-budget");
  });

  it("cancels queued work immediately and applies the shared enqueue deadline", async () => {
    operations.length = 0;
    const scheduler = new DocumentExtractionScheduler({ concurrency: 1 });
    const blocker = scheduler.schedule({
      groupId: "blocker",
      weight: 1,
      deadlineAt: Date.now() + 5_000,
      operation: controlled("blocker", []),
    });
    const controller = new AbortController();
    const cancelled = scheduler.schedule({
      groupId: "cancelled",
      weight: 1,
      deadlineAt: Date.now() + 5_000,
      signal: controller.signal,
      operation: controlled("must-not-start", []),
    });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(
      DocumentExtractionCancelledError,
    );
    const expired = scheduler.schedule({
      groupId: "expired",
      weight: 1,
      deadlineAt: Date.now() + 10,
      operation: controlled("also-must-not-start", []),
    });
    await expect(expired).rejects.toBeInstanceOf(
      DocumentExtractionDeadlineError,
    );
    operations[0]!.resolve();
    await blocker;
  });

  it("unlinks cancelled and expired queued buffers while occupied work never settles", async () => {
    const scheduler = new DocumentExtractionScheduler({ concurrency: 1 });
    void scheduler.schedule({
      groupId: "never-settles",
      weight: 1,
      deadlineAt: Date.now() + 60_000,
      operation: () => new Promise<string>(() => undefined),
    }).catch(() => undefined);
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const cancelled = controllers.map((controller, index) => scheduler.schedule({
      groupId: `cancelled-${index}`,
      weight: 1,
      deadlineAt: Date.now() + 60_000,
      signal: controller.signal,
      operation: async () => "must-not-run",
    }));
    controllers.forEach((controller) => controller.abort());
    await Promise.all(cancelled.map((operation) =>
      expect(operation).rejects.toBeInstanceOf(DocumentExtractionCancelledError)));
    expect(scheduler.queuedJobCount()).toBe(0);

    const expired = Array.from({ length: 64 }, (_, index) => scheduler.schedule({
      groupId: `expired-${index}`,
      weight: 1,
      deadlineAt: Date.now() + 1,
      operation: async () => "must-not-run",
    }));
    await Promise.all(expired.map((operation) =>
      expect(operation).rejects.toBeInstanceOf(DocumentExtractionDeadlineError)));
    expect(scheduler.queuedJobCount()).toBe(0);
  });

  it("holds capacity until a timed-out extractor has actually stopped", async () => {
    const starts: string[] = [];
    let stopTimedOut: (() => void) | undefined;
    const scheduler = new DocumentExtractionScheduler({ concurrency: 1 });
    const timedOut = scheduler.schedule({
      groupId: "timed-out",
      weight: 1,
      deadlineAt: Date.now() + 10,
      operation: async () => {
        starts.push("timed-out");
        await new Promise<void>((resolve) => {
          stopTimedOut = resolve;
        });
        return "late";
      },
    });
    const next = scheduler.schedule({
      groupId: "next",
      weight: 1,
      deadlineAt: Date.now() + 5_000,
      operation: async () => {
        starts.push("next");
        return "next";
      },
    });

    await expect(timedOut).rejects.toBeInstanceOf(
      DocumentExtractionDeadlineError,
    );
    expect(starts).toEqual(["timed-out"]);
    stopTimedOut?.();
    await expect(next).resolves.toBe("next");
    expect(starts).toEqual(["timed-out", "next"]);
  });

  it("reports the first document failure deterministically and enforces aggregate caps", async () => {
    await expect(documentAttachmentContexts([
      {
        attachment: attachment(1, "first.txt"),
        bytes: new Uint8Array([0xff]),
      },
      {
        attachment: attachment(2, "second.txt"),
        bytes: new Uint8Array(),
      },
    ])).rejects.toThrow("first.txt is not valid UTF-8 text.");

    const tooMany = Array.from({ length: 9 }, (_, index) => ({
      attachment: attachment(index + 1, `${index + 1}.txt`),
      bytes: Buffer.from("bounded"),
    }));
    await expect(documentAttachmentContexts(tooMany))
      .rejects.toThrow(/shared extraction budget/u);
  });
});
