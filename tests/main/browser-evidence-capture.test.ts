import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";

import {
  BrowserEvidenceCapture,
  type BrowserEvidencePage,
} from "../../src/main/browser-evidence-capture";

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

  it("sanitizes the complete hostile console batch within one bounded deadline", async () => {
    const page: BrowserEvidencePage = {
      tabId: "11111111-1111-4111-8111-111111111111",
      pageNumber: 1,
      documentSequence: 1,
      contents: {} as BrowserEvidencePage["contents"],
    };
    const publish = vi.fn();
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

    const startedAt = performance.now();
    for (let index = 0; index < 160; index += 1) {
      capture.recordConsoleError(page, hostile[index % hostile.length]);
    }
    await vi.waitFor(
      () => expect(publish).toHaveBeenCalledTimes(160),
      { interval: 5, timeout: 1_500 },
    );
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(capture.snapshot()).toMatchObject({
      omitted: true,
      entries: expect.any(Array),
    });
  });
});
