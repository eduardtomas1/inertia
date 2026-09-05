import { describe, expect, it } from "vitest";
import { collectGuardianFailureCodes } from "./guardian-failure-codes";

describe("native guardian failure evidence", () => {
  it("retains only recognized codes from direct and enveloped terminal frames", () => {
    const data = "private output and credentials\r\n"
      + "[Inertia guardian cleanup unproved: freeze-post-stop-census/session-live-identity-unreadable]\r\n"
      + "[Inertia guardian cleanup unproved: private-token/secret-value]\r\n";
    const event = { type: "terminal.output", terminalId: "private-id", data };
    const expected = [{ phase: "freeze-post-stop-census", census: "session-live-identity-unreadable" }];
    expect(collectGuardianFailureCodes([], JSON.stringify(event))).toEqual(expected);
    expect(collectGuardianFailureCodes([], Buffer.from(JSON.stringify({ type: "runtime.event", event })))).toEqual(expected);
  });

  it("ignores malformed, oversized and unrelated frames without growing retained state", () => {
    const previous = [{ phase: "drain-timeout", census: "none" }];
    for (const payload of [
      "not JSON", "null", "[]", "1", JSON.stringify({ type: "runtime.event", event: null }),
      JSON.stringify({ type: "terminal.output", data: { private: "output" } }),
      JSON.stringify({ type: "snapshot.updated", data: "[Inertia guardian cleanup unproved: drain-timeout/none]" }),
      JSON.stringify({ type: "terminal.output", data: "x".repeat(1_048_576) }),
    ]) expect(collectGuardianFailureCodes(previous, payload)).toBe(previous);
  });

  it("keeps at most the latest eight code pairs across repeated failures", () => {
    const first = [{ phase: "term-fork-taint", census: "none" }];
    const payload = JSON.stringify({
      type: "terminal.output",
      data: "[Inertia guardian cleanup unproved: drain-census/pid-list]".repeat(20),
    });
    expect(collectGuardianFailureCodes(first, payload)).toEqual(
      Array.from({ length: 8 }, () => ({ phase: "drain-census", census: "pid-list" })),
    );
    expect(first).toEqual([{ phase: "term-fork-taint", census: "none" }]);
  });
});
