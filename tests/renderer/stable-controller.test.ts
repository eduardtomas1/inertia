import { describe, expect, it } from "vitest";

import {
  createStableActionProxy,
  shallowControllerEqual,
} from "../../src/renderer/src/utils/stableController";

describe("stable controller envelopes", () => {
  it("ignores a new envelope when every exposed member retains identity", () => {
    const callback = () => undefined;
    expect(
      shallowControllerEqual(
        { status: "ready", callback },
        { status: "ready", callback },
      ),
    ).toBe(true);
    expect(
      shallowControllerEqual(
        { status: "ready", callback },
        { status: "busy", callback },
      ),
    ).toBe(false);
  });

  it("keeps wrapper identity while dispatching to the latest action set", () => {
    let multiplier = 2;
    const latest = {
      calculate: (value: number) => value * multiplier,
    };
    const proxy = createStableActionProxy(
      ["calculate"],
      (key, arguments_) =>
        latest[key](...(arguments_ as unknown as [number])),
    );
    const stableCalculate = proxy.calculate;
    expect(stableCalculate(3)).toBe(6);
    multiplier = 4;
    expect(proxy.calculate).toBe(stableCalculate);
    expect(proxy.calculate(3)).toBe(12);
  });
});
