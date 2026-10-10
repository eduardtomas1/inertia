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

    expect(previewAppShortcutKey(input, "darwin")).toBe("k");
    expect(previewAppShortcutKey({ ...input, meta: false, control: true }, "darwin")).toBe("k");
    expect(previewAppShortcutKey({ ...input, key: "w" }, "darwin")).toBe("w");
    expect(previewAppShortcutKey({ ...input, key: "w", meta: false, control: true }, "linux")).toBe("w");
    expect(previewAppShortcutKey({ ...input, key: "w", shift: true }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, key: "X" }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, meta: false }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, alt: true }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, type: "keyUp" }, "darwin")).toBeNull();
  });

  it("leaves Ctrl+W to the page on macOS and Cmd+W to the page elsewhere", () => {
    const input = {
      type: "keyDown",
      key: "w",
      control: true,
      meta: false,
      alt: false,
      shift: false,
    };

    expect(previewAppShortcutKey(input, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, control: false, meta: true }, "linux")).toBeNull();
    expect(previewAppShortcutKey({ ...input, control: false, meta: true }, "win32")).toBeNull();
    expect(previewAppShortcutKey({ ...input, meta: true }, "darwin")).toBeNull();
    expect(previewAppShortcutKey(input, "win32")).toBe("w");
  });
});
