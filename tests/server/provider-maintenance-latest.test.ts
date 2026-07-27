import { describe, expect, it, vi } from "vitest";

import {
  compareProviderVersions,
  ProviderLatestVersionCache,
} from "../../src/server/provider/maintenance-latest";

describe("ProviderLatestVersionCache", () => {
  it("deduplicates refreshes and serves a fresh bounded result from cache", async () => {
    const request = vi.fn(async () => new Response(
      JSON.stringify({ version: "2.3.4" }),
      { status: 200 },
    ));
    let now = 1_000_000;
    const cache = new ProviderLatestVersionCache({
      fetch: request as typeof fetch,
      now: () => now,
      successTtlMs: 60_000,
    });

    const [first, concurrent] = await Promise.all([
      cache.latest("@openai/codex"),
      cache.latest("@openai/codex"),
    ]);
    now += 1_000;
    const cached = await cache.latest("@openai/codex");

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ version: "2.3.4", freshness: "fresh" });
    expect(concurrent).toEqual(first);
    expect(cached).toEqual(first);
  });

  it("keeps the last known valid version stale after a transient failure", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ version: "2.3.4" }),
        { status: 200 },
      ))
      .mockRejectedValueOnce(new Error("offline"));
    let now = 1_000_000;
    const cache = new ProviderLatestVersionCache({
      fetch: request as typeof fetch,
      now: () => now,
      successTtlMs: 60_000,
      failureTtlMs: 10_000,
    });
    await cache.latest("@openai/codex");
    now += 61_000;

    const stale = await cache.latest("@openai/codex");

    expect(stale).toMatchObject({
      version: "2.3.4",
      freshness: "stale",
      error: "Latest-version information is temporarily unavailable.",
    });
  });

  it("rejects malformed and oversized registry payloads honestly", async () => {
    const responses = [
      new Response(JSON.stringify({ version: "not-a-version" }), { status: 200 }),
      new Response(JSON.stringify({ version: `1.0.0${"x".repeat(20_000)}` }), {
        status: 200,
      }),
    ];
    const request = vi.fn(async () => responses.shift()!);
    const cache = new ProviderLatestVersionCache({
      fetch: request as typeof fetch,
      failureTtlMs: 10_000,
    });

    expect(await cache.latest("invalid", true)).toMatchObject({
      version: null,
      freshness: "unavailable",
    });
    expect(await cache.latest("oversized", true)).toMatchObject({
      version: null,
      freshness: "unavailable",
    });
  });
});
describe("compareProviderVersions", () => {
  it("compares stable and prerelease versions without treating unknown text as current", () => {
    expect(compareProviderVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareProviderVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareProviderVersions("1.2.3-alpha.2", "1.2.3")).toBeLessThan(0);
    expect(compareProviderVersions("1.2.3-alpha.10", "1.2.3-alpha.2")).toBeGreaterThan(0);
    expect(compareProviderVersions("dev", "1.2.3")).toBeNull();
  });
});
