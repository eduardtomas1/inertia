import { describe, expect, it } from "vitest";

import { createBoundedCache } from "../../src/renderer/src/utils/boundedCache";

describe("bounded cache", () => {
  it("evicts the least recently used entry beyond its entry limit", () => {
    const cache = createBoundedCache<string>(2, 100, () => 1);
    cache.set("a", "first");
    cache.set("b", "second");
    expect(cache.get("a")).toBe("first");
    cache.set("c", "third");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("first");
    expect(cache.get("c")).toBe("third");
  });

  it("evicts old entries to stay within its weight limit and skips oversized values", () => {
    const cache = createBoundedCache<string>(10, 10, (_key, value) => value.length);
    cache.set("a", "aaaa");
    cache.set("b", "bbbb");
    cache.set("c", "cccc");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("bbbb");

    cache.set("d", "d".repeat(11));
    expect(cache.get("d")).toBeUndefined();
    expect(cache.get("c")).toBe("cccc");
  });

  it("replaces an entry without double counting its weight", () => {
    const cache = createBoundedCache<string>(10, 8, (_key, value) => value.length);
    cache.set("a", "aaaa");
    cache.set("a", "AAAA");
    cache.set("b", "bbbb");

    expect(cache.get("a")).toBe("AAAA");
    expect(cache.get("b")).toBe("bbbb");
  });

  it("keeps cached null values distinguishable from misses", () => {
    const cache = createBoundedCache<string | null>(2, 10, () => 1);
    cache.set("unhighlightable", null);

    expect(cache.get("unhighlightable")).toBeNull();
    expect(cache.get("missing")).toBeUndefined();
  });
});
