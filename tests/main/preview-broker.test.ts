import { describe, expect, it } from "vitest";

import {
  createPreviewPartition,
  previewAppShortcutKey,
} from "../../src/main/preview-broker";
import {
  parsePreviewAppShortcutKeys,
  setPreviewAppShortcutKeys,
} from "../../src/main/preview-keyboard";
import { APP_SHORTCUT_KEYS, DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";

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
    expect(previewAppShortcutKey({ ...input, key: "T" }, "darwin")).toBe("t");
    expect(previewAppShortcutKey({ ...input, key: "w" }, "darwin")).toBe("w");
    expect(previewAppShortcutKey({ ...input, key: "G" }, "darwin")).toBe("g");
    expect(previewAppShortcutKey({ ...input, key: "w", meta: false, control: true }, "linux")).toBe("w");
    expect(previewAppShortcutKey({ ...input, key: "w", shift: true }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, key: "X" }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, meta: false }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, alt: true }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, type: "keyUp" }, "darwin")).toBeNull();
  });

  it("leaves Control chords to the page on macOS, where Command is the app modifier", () => {
    const input = { type: "keyDown", control: true, meta: false, alt: false, shift: false };
    for (const key of ["k", "y", "h", "u", "b", "n"]) {
      expect(previewAppShortcutKey({ ...input, key }, "darwin"), key).toBeNull();
    }
    expect(previewAppShortcutKey({ ...input, key: "k", meta: true }, "darwin")).toBeNull();
    expect(previewAppShortcutKey({ ...input, key: "k", control: false, meta: true }, "linux")).toBeNull();
    expect(previewAppShortcutKey({ ...input, key: "k", control: false, meta: true }, "win32")).toBeNull();
  });

  it("leaves unbound pool keys to the page and forwards the keys currently bound", () => {
    const bound = new Set(Object.values(DEFAULT_APP_KEYBINDINGS));
    expect(APP_SHORTCUT_KEYS).toEqual(expect.arrayContaining(["h", "u", "y"]));
    for (const platform of ["darwin", "linux", "win32"]) {
      const input = {
        type: "keyDown",
        control: platform !== "darwin",
        meta: platform === "darwin",
        alt: false,
        shift: false,
      };
      for (const key of APP_SHORTCUT_KEYS) {
        const expected = bound.has(key) ? key : null;
        expect(previewAppShortcutKey({ ...input, key: key.toUpperCase() }, platform, bound), `${platform} ${key}`).toBe(expected);
        expect(previewAppShortcutKey({ ...input, key, shift: true }, platform, bound)).toBeNull();
      }
      expect(previewAppShortcutKey({ ...input, key: "y" }, platform, bound)).toBeNull();
      expect(previewAppShortcutKey({ ...input, key: "w" }, platform, new Set())).toBe("w");
    }
  });

  it("follows the bindings the renderer reports and rejects malformed reports", () => {
    const input = { type: "keyDown", key: "y", control: true, meta: false, alt: false, shift: false };
    try {
      expect(previewAppShortcutKey(input, "win32")).toBeNull();
      const rebound = parsePreviewAppShortcutKeys(["y", "n", "b", "j", "t", "g"]);
      expect(rebound).not.toBeNull();
      setPreviewAppShortcutKeys(rebound!);
      expect(previewAppShortcutKey(input, "win32")).toBe("y");
      expect(previewAppShortcutKey({ ...input, key: "k" }, "win32")).toBeNull();
      expect(parsePreviewAppShortcutKeys(["k", "k"])).toBeNull();
      expect(parsePreviewAppShortcutKeys(["x"])).toBeNull();
      expect(parsePreviewAppShortcutKeys("k")).toBeNull();
      expect(parsePreviewAppShortcutKeys([...APP_SHORTCUT_KEYS, "w"])).toBeNull();
      expect(parsePreviewAppShortcutKeys([])).toEqual([]);
    } finally {
      setPreviewAppShortcutKeys(Object.values(DEFAULT_APP_KEYBINDINGS));
    }
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
