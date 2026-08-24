import { describe, expect, it } from "vitest";

import {
  createPreviewPartition,
  previewAppShortcutKey,
} from "../../src/main/preview-broker";

describe("preview broker isolation", () => {
  it("assigns each native preview an unpredictable non-persistent partition", () => {
    const first = createPreviewPartition();
    const second = createPreviewPartition();

    expect(first).toMatch(/^inertia-preview-[0-9a-f-]{36}$/u);
    expect(second).toMatch(/^inertia-preview-[0-9a-f-]{36}$/u);
    expect(second).not.toBe(first);
    expect(first.startsWith("persist:")).toBe(false);
    expect(second.startsWith("persist:")).toBe(false);
    expect(createPreviewPartition("inertia-canary-preview"))
      .toMatch(/^inertia-canary-preview-[0-9a-f-]{36}$/u);
  });

  it("recognizes only exact app shortcuts from native preview input", () => {
    const input = {
      type: "keyDown",
      key: "K",
      control: false,
      meta: true,
      alt: false,
      shift: false,
    };

    expect(previewAppShortcutKey(input)).toBe("k");
    expect(previewAppShortcutKey({ ...input, key: "X" })).toBeNull();
    expect(previewAppShortcutKey({ ...input, meta: false })).toBeNull();
    expect(previewAppShortcutKey({ ...input, alt: true })).toBeNull();
    expect(previewAppShortcutKey({ ...input, type: "keyUp" })).toBeNull();
  });
});
