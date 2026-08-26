import { describe, expect, it } from "vitest";

import { RuntimeSystemSuspendTracker } from "../../src/main/runtime-system-suspend-tracker";

describe("RuntimeSystemSuspendTracker", () => {
  it("retains one completed interval and ignores duplicate suspend signals", () => {
    const tracker = new RuntimeSystemSuspendTracker();
    tracker.suspend("2026-08-25T12:15:39.000Z");
    tracker.suspend("2026-08-25T12:16:00.000Z");

    expect(tracker.resume("2026-08-26T05:10:02.000Z")).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      suspendedAt: "2026-08-25T12:15:39.000Z",
      resumedAt: "2026-08-26T05:10:02.000Z",
    });
    expect(tracker.resume("2026-08-26T05:11:00.000Z")).toBeNull();
    expect(tracker.completed()).toHaveLength(1);
  });
});
