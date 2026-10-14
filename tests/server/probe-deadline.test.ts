// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import { slowMachineProbeDeadline } from "../../src/server/provider/probe-deadline";

describe("slow machine probe deadlines", () => {
  it("keeps the base deadline after a normal version answer", () => {
    expect(slowMachineProbeDeadline(4_000, undefined)).toBe(4_000);
    expect(slowMachineProbeDeadline(4_000, 120)).toBe(4_000);
    expect(slowMachineProbeDeadline(4_000, 500)).toBe(4_000);
  });

  it("stretches in proportion to a slow version answer up to a bounded ceiling", () => {
    expect(slowMachineProbeDeadline(4_000, 1_000)).toBe(8_000);
    expect(slowMachineProbeDeadline(6_000, 1_250)).toBe(15_000);
    expect(slowMachineProbeDeadline(6_000, 60_000)).toBe(30_000);
    expect(slowMachineProbeDeadline(30_000, 2_000)).toBe(30_000);
  });
});
