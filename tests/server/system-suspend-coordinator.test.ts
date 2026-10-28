import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_STOPPED_WHILE_ASLEEP_NOTE,
  recordSystemSuspendInterval,
} from "../../src/server/runtime/system-suspend-coordinator";

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

  it("asks the turn controller to release chats whose provider exited while the computer slept", () => {
    const record = vi.fn(() => []);
    const turns = { settleTurnsWhoseProviderExited: vi.fn(() => []), restampProviderActivity: vi.fn() };

    expect(recordSystemSuspendInterval(
      { systemSuspends: { record } },
      interval,
      vi.fn(),
      vi.fn(),
      turns,
    )).toBe(true);

    expect(turns.settleTurnsWhoseProviderExited)
      .toHaveBeenCalledExactlyOnceWith(PROVIDER_STOPPED_WHILE_ASLEEP_NOTE);
    expect(turns.restampProviderActivity).toHaveBeenCalledOnce();
    expect(record.mock.invocationCallOrder[0])
      .toBeLessThan(turns.settleTurnsWhoseProviderExited.mock.invocationCallOrder[0]!);
  });

  it("still checks provider liveness when accounting fails, and keeps a liveness failure inside the command boundary", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const livenessFailure = new Error("turn store unavailable");
    const turns = {
      settleTurnsWhoseProviderExited: vi.fn(() => { throw livenessFailure; }),
      restampProviderActivity: vi.fn(),
    };

    expect(recordSystemSuspendInterval({
      systemSuspends: { record: vi.fn(() => { throw new Error("overlap"); }) },
    }, interval, vi.fn(), vi.fn(), turns)).toBe(false);

    expect(turns.settleTurnsWhoseProviderExited).toHaveBeenCalledOnce();
    expect(turns.restampProviderActivity).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Unable to check provider liveness after a system resume.",
      livenessFailure,
    );
    error.mockRestore();
  });

  it("re-checks providers after a recorded resume and never after a failed record", () => {
    const resumed = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(recordSystemSuspendInterval({
      systemSuspends: { record: vi.fn(() => { throw new Error("unreadable interval"); }) },
    }, interval, vi.fn(), vi.fn(), undefined, resumed)).toBe(false);
    expect(resumed).not.toHaveBeenCalled();

    expect(recordSystemSuspendInterval({
      systemSuspends: { record: vi.fn(() => []) },
    }, interval, vi.fn(), vi.fn(), undefined, resumed)).toBe(true);
    expect(recordSystemSuspendInterval({
      systemSuspends: { record: vi.fn(() => ["conversation-1"]) },
    }, interval, vi.fn(), vi.fn(), undefined, resumed)).toBe(true);
    expect(resumed).toHaveBeenCalledTimes(2);

    error.mockRestore();
  });
});
