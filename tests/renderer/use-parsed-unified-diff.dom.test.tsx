import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseUnifiedDiff } from "../../src/shared/diff-review";
import {
  DIFF_WORKER_THRESHOLD_CHARS,
  useParsedUnifiedDiff,
} from "../../src/renderer/src/hooks/useParsedUnifiedDiff";

const parseDiffOffMainThread = vi.hoisted(() => vi.fn());

vi.mock("../../src/renderer/src/utils/diffParserPool", () => ({
  parseDiffOffMainThread,
}));

afterEach(() => {
  parseDiffOffMainThread.mockReset();
  vi.unstubAllGlobals();
});

describe("useParsedUnifiedDiff", () => {
  it("keeps ordinary patches synchronous", () => {
    const patch = "diff --git a/a.ts b/a.ts\n";
    const hook = renderHook(() => useParsedUnifiedDiff(patch));

    expect(hook.result.current.parsing).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(parseDiffOffMainThread).not.toHaveBeenCalled();
  });

  it("offloads a large patch and aborts superseded work", async () => {
    vi.stubGlobal("Worker", class {});
    const pending: Array<{
      patch: string;
      signal: AbortSignal;
      resolve: (value: ReturnType<typeof parseUnifiedDiff>) => void;
    }> = [];
    parseDiffOffMainThread.mockImplementation((
      patch: string,
      signal: AbortSignal,
    ) => new Promise((resolve) => pending.push({ patch, signal, resolve })));
    const first = "x".repeat(DIFF_WORKER_THRESHOLD_CHARS + 1);
    const second = "y".repeat(DIFF_WORKER_THRESHOLD_CHARS + 2);
    const hook = renderHook(({ patch }) => useParsedUnifiedDiff(patch), {
      initialProps: { patch: first },
    });

    expect(hook.result.current.parsing).toBe(true);
    hook.rerender({ patch: second });
    expect(pending[0]?.signal.aborted).toBe(true);
    pending[1]?.resolve(parseUnifiedDiff(second));

    await waitFor(() => expect(hook.result.current.parsing).toBe(false));
    expect(hook.result.current.error).toBeNull();
    expect(parseDiffOffMainThread).toHaveBeenCalledTimes(2);
  });

  it("retries a failed large patch when its authoritative snapshot refreshes", async () => {
    vi.stubGlobal("Worker", class {});
    const patch = "x".repeat(DIFF_WORKER_THRESHOLD_CHARS + 1);
    const firstSnapshot = { revision: 1 };
    const secondSnapshot = { revision: 2 };
    parseDiffOffMainThread
      .mockRejectedValueOnce(new Error("The diff worker stopped."))
      .mockResolvedValueOnce(parseUnifiedDiff(patch));
    const hook = renderHook(
      ({ retryToken }) => useParsedUnifiedDiff(patch, retryToken),
      { initialProps: { retryToken: firstSnapshot } },
    );

    await waitFor(() => expect(hook.result.current.error)
      .toBe("The diff worker stopped."));
    hook.rerender({ retryToken: secondSnapshot });

    await waitFor(() => expect(hook.result.current.parsing).toBe(false));
    expect(hook.result.current.error).toBeNull();
    expect(parseDiffOffMainThread).toHaveBeenCalledTimes(2);
  });
});
