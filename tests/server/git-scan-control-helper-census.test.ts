import { describe, expect, it } from "vitest";

import { controlHelperCensus } from "../helpers/linux-control-helper-census.mjs";

function helper(pid: number, target: number, action: string | null, mode = "signal") {
  return { pid, mode, target, action };
}

const childFree = (): number => 0;

describe("Linux control helper census", () => {
  it("counts the CI burst peak's exec-to-release handoff once per inspection", () => {
    expect(controlHelperCensus([
      helper(47725, 47713, "release"),
      helper(47724, 47710, "exec"),
      helper(47723, 47716, "exec"),
      helper(47722, 47713, "exec"),
    ], childFree)).toEqual({ admission: 3, release: 1, handoffs: 1, violations: [] });
  });

  it("counts the CI global peak's admissions without a handoff", () => {
    expect(controlHelperCensus([
      helper(48572, 48561, "claim"),
      helper(48571, 48564, "claim"),
      helper(48570, 48567, "claim"),
      helper(48559, 48555, "exec"),
    ], childFree)).toEqual({ admission: 4, release: 0, handoffs: 0, violations: [] });
  });

  it("rejects two admission helpers for one guardian", () => {
    const helpers = [helper(11, 10, null, "ready"), helper(12, 10, "claim")];
    expect(controlHelperCensus(helpers, childFree).violations).toEqual([
      { target: 10, helpers },
    ]);
  });

  it("rejects a release helper beside any admission step other than exec", () => {
    expect(controlHelperCensus([
      helper(12, 10, "claim"),
      helper(13, 10, "release"),
    ], childFree).violations).toHaveLength(1);
  });

  it("rejects a release helper while the guardian still has a child", () => {
    expect(controlHelperCensus([
      helper(12, 10, "exec"),
      helper(13, 10, "release"),
    ], () => 1)).toMatchObject({
      handoffs: 0,
      violations: [{ target: 10, children: 1 }],
    });
  });

  it("rejects two release helpers for one guardian", () => {
    expect(controlHelperCensus([
      helper(12, 10, "release"),
      helper(13, 10, "release"),
    ], childFree).violations).toHaveLength(1);
  });
});
