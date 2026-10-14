import { describe, expect, it } from "vitest";

import { virtualWindowCoversViewport } from "../../src/renderer/src/components/response-timeline/useViewportSyncedVirtualizer";

describe("virtual window viewport coverage", () => {
  const rendered = { start: 1_000, end: 6_000, totalSize: 40_000 };

  it("lets a scroll inside the rendered rows paint before React re-renders", () => {
    expect(virtualWindowCoversViewport(rendered, 1_000, 700, 40_000)).toBe(true);
    expect(virtualWindowCoversViewport(rendered, 5_300, 700, 40_000)).toBe(true);
  });

  it("renders synchronously when the viewport leaves the rendered rows", () => {
    expect(virtualWindowCoversViewport(rendered, 999, 700, 40_000)).toBe(false);
    expect(virtualWindowCoversViewport(rendered, 5_301, 700, 40_000)).toBe(false);
    expect(virtualWindowCoversViewport(rendered, 20_000, 700, 40_000)).toBe(false);
  });

  it("renders synchronously after a measurement changed the layout", () => {
    expect(virtualWindowCoversViewport(rendered, 2_000, 700, 39_880)).toBe(false);
  });

  it("renders synchronously before anything was rendered or measured", () => {
    expect(virtualWindowCoversViewport(null, 2_000, 700, 40_000)).toBe(false);
    expect(virtualWindowCoversViewport(rendered, null, 700, 40_000)).toBe(false);
    expect(virtualWindowCoversViewport(rendered, 2_000, undefined, 40_000)).toBe(false);
  });
});
