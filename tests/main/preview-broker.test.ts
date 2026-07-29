import { describe, expect, it } from "vitest";

import { createPreviewPartition } from "../../src/main/preview-broker";

describe("preview broker isolation", () => {
  it("assigns each native preview an unpredictable non-persistent partition", () => {
    const first = createPreviewPartition();
    const second = createPreviewPartition();

    expect(first).toMatch(/^inertia-preview-[0-9a-f-]{36}$/u);
    expect(second).toMatch(/^inertia-preview-[0-9a-f-]{36}$/u);
    expect(second).not.toBe(first);
    expect(first.startsWith("persist:")).toBe(false);
    expect(second.startsWith("persist:")).toBe(false);
  });
});
