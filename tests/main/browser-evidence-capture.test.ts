import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserEvidenceCapture,
  type BrowserEvidencePage,
} from "../../src/main/browser-evidence-capture";

const threadCpuUsage = (
  process as typeof process & {
    threadCpuUsage?(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage;
  }
).threadCpuUsage?.bind(process);
const enforceThreadCpuBudget =
  process.env.INERTIA_ENFORCE_BROWSER_EVIDENCE_CPU_BUDGET === "1";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Browser evidence capture", () => {
  it("keeps same-millisecond delayed errors on both sides of a navigation", async () => {
    vi.useFakeTimers();
    const firstInspection = deferred<boolean>();
    const page: BrowserEvidencePage = {
      tabId: "11111111-1111-4111-8111-111111111111",
      pageNumber: 1,
      documentSequence: 1,
      contents: {} as BrowserEvidencePage["contents"],
    };
    const capture = new BrowserEvidenceCapture({
      isLive: () => true,
      isCurrent: () => true,
      publish: vi.fn(),
      sensitiveDocument: vi.fn()
        .mockImplementationOnce(async () => await firstInspection.promise)
        .mockResolvedValueOnce(false),
    });

    vi.setSystemTime("2026-08-23T11:00:00.000Z");
    capture.recordConsoleError(page, "identical delayed error");
    capture.recordNavigation(page, "https://example.com/history", true);
    capture.recordConsoleError(page, "identical delayed error");
    firstInspection.resolve(false);
    await vi.waitFor(() => expect(capture.snapshot().entries).toHaveLength(3));

    expect(capture.snapshot().entries).toMatchObject([
      { kind: "console-error", occurrences: 1, sequence: 1 },
      { kind: "navigation", occurrences: 1, sequence: 2 },
      { kind: "console-error", occurrences: 1, sequence: 3 },
    ]);
  });

  it("keeps console occurrence times when cross-tab inspections settle out of order", async () => {
    vi.useFakeTimers();
    const firstInspection = deferred<boolean>();
    const secondInspection = deferred<boolean>();
    const inspections = [firstInspection, secondInspection];
    const pages: BrowserEvidencePage[] = [
      {
        tabId: "11111111-1111-4111-8111-111111111111",
        pageNumber: 1,
        documentSequence: 1,
        contents: {} as BrowserEvidencePage["contents"],
      },
      {
        tabId: "22222222-2222-4222-8222-222222222222",
        pageNumber: 2,
        documentSequence: 1,
        contents: {} as BrowserEvidencePage["contents"],
      },
    ];
    const capture = new BrowserEvidenceCapture({
      isLive: () => true,
      isCurrent: () => true,
      publish: vi.fn(),
      sensitiveDocument: vi.fn(async () => await inspections.shift()!.promise),
    });

    vi.setSystemTime("2026-08-23T07:00:00.000Z");
    capture.recordConsoleError(pages[0]!, "first failure");
    vi.setSystemTime("2026-08-23T07:00:01.000Z");
    capture.recordConsoleError(pages[1]!, "second failure");
    vi.setSystemTime("2026-08-23T07:00:02.000Z");
    capture.recordNavigation(
      pages[0]!,
      "https://example.com/after-console",
      true,
    );
    vi.setSystemTime("2026-08-23T07:00:05.000Z");
    secondInspection.resolve(false);
    await Promise.resolve();
    expect(capture.snapshot().entries).toMatchObject([{ kind: "navigation" }]);
    firstInspection.resolve(false);
    await vi.waitFor(() => expect(capture.snapshot().entries).toHaveLength(3));

    expect(capture.snapshot().entries).toEqual([
      expect.objectContaining({
        detail: "first failure",
        occurredAt: "2026-08-23T07:00:00.000Z",
      }),
      expect.objectContaining({
        detail: "second failure",
        occurredAt: "2026-08-23T07:00:01.000Z",
      }),
      expect.objectContaining({
        kind: "navigation",
        occurredAt: "2026-08-23T07:00:02.000Z",
      }),
    ]);
  });

  it("sanitizes and bounds the complete hostile console batch", async () => {
    const page: BrowserEvidencePage = {
      tabId: "11111111-1111-4111-8111-111111111111",
      pageNumber: 1,
      documentSequence: 1,
      contents: {} as BrowserEvidencePage["contents"],
    };
    const published = deferred<void>();
    let publishCount = 0;
    const publish = vi.fn(() => {
      publishCount += 1;
      if (publishCount === 160) published.resolve();
    });
    const capture = new BrowserEvidenceCapture({
      isLive: () => true,
      isCurrent: () => true,
      publish,
      sensitiveDocument: vi.fn().mockResolvedValue(false),
    });
    const hostile = [
      `${"a".repeat(4_680)}//x`,
      "a/".repeat(2_340),
    ];

    if (enforceThreadCpuBudget && !threadCpuUsage) {
      throw new Error(
        "The browser-evidence CPU budget requires process.threadCpuUsage.",
      );
    }
    const cpuStartedAt = enforceThreadCpuBudget ? threadCpuUsage!() : null;
    for (let index = 0; index < 160; index += 1) {
      capture.recordConsoleError(page, hostile[index % hostile.length]);
    }
    await published.promise;

    const cpu = cpuStartedAt && threadCpuUsage
      ? threadCpuUsage(cpuStartedAt)
      : null;
    // Keep this production-speed assertion in a fresh, uninstrumented worker.
    // Concurrent V8 coverage collection adds unrelated per-thread CPU work;
    // test:coverage still runs every exact assertion below.
    if (cpu) expect(cpu.user + cpu.system).toBeLessThan(1_500_000);
    expect(publish).toHaveBeenCalledTimes(160);
    const snapshot = capture.snapshot();
    expect(snapshot.omitted).toBe(true);
    expect(snapshot.entries).toHaveLength(100);
    expect(snapshot.entries.every((entry) => (
      entry.kind === "console-error" && entry.redacted
    ))).toBe(true);
    expect(snapshot.entries.map((entry) => entry.detail)).toEqual(
      Array.from({ length: 100 }, (_, index) => (
        index % 2 === 0
          ? "a".repeat(600)
          : "Sensitive console detail hidden"
      )),
    );
  });
});
