import { describe, expect, it, vi } from "vitest";

import { recordSystemSuspendInterval } from "../../src/server/runtime/system-suspend-coordinator";

const interval = {
  id: "11111111-1111-4111-8111-111111111111",
  suspendedAt: "2026-08-26T08:00:00.000Z",
  resumedAt: "2026-08-26T08:05:00.000Z",
};

describe("system suspend coordinator", () => {
  it("keeps advisory suspend-accounting failures inside the command boundary", () => {
    const failure = new Error("overlapping persisted interval");
    const broadcast = vi.fn();
    const broadcastSnapshot = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(recordSystemSuspendInterval({
      systemSuspends: {
        record: vi.fn(() => {
          throw failure;
        }),
      },
    }, interval, broadcast, broadcastSnapshot)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "Unable to record system suspend accounting.",
      failure,
    );
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastSnapshot).not.toHaveBeenCalled();

    error.mockRestore();
  });

  it("acknowledges idempotent persistence even when no view changed", () => {
    const broadcast = vi.fn();
    const broadcastSnapshot = vi.fn();

    expect(recordSystemSuspendInterval({
      systemSuspends: { record: vi.fn(() => []) },
    }, interval, broadcast, broadcastSnapshot)).toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastSnapshot).not.toHaveBeenCalled();
  });
});
