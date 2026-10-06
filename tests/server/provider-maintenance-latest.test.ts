import { describe, expect, it, vi } from "vitest";

import {
  compareProviderVersions,
  ProviderLatestVersionCache,
} from "../../src/server/provider/maintenance-latest";

describe("ProviderLatestVersionCache", () => {
  it.each([
    [true, { formulae: [], casks: [{ version: "0.160.0,a1b2c3" }] }, "0.160.0"],
    [false, { formulae: [{ versions: { stable: "1.18.30" } }], casks: [] }, "1.18.30"],
  ])("reads the release a Homebrew keg can upgrade to (cask %s)", async (cask, info, version) => {
    const fetch = vi.fn();
    const homebrewInfo = vi.fn(async () => JSON.stringify(info));
    let now = 1_000_000;
    const cache = new ProviderLatestVersionCache({
      fetch: fetch as typeof globalThis.fetch,
      homebrewInfo,
      now: () => now,
    });
    const source = { brew: "/home/linuxbrew/.linuxbrew/bin/brew", name: cask ? "codex" : "opencode", cask };

    await expect(cache.homebrew(source)).resolves.toMatchObject({ version, freshness: "fresh", error: null });
    now += 1_000;
    await expect(cache.homebrew(source)).resolves.toMatchObject({ version });
    expect(homebrewInfo).toHaveBeenCalledTimes(1);
    expect(homebrewInfo).toHaveBeenCalledWith(source.brew, [
      "info", "--json=v2", cask ? "--cask" : "--formula", source.name,
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a Homebrew read that fails or returns no version as unavailable", async () => {
    const homebrewInfo = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ formulae: [], casks: [{}] }));
    let now = 1_000_000;
    const cache = new ProviderLatestVersionCache({ homebrewInfo, now: () => now });
    const source = { brew: "/opt/homebrew/bin/brew", name: "claude-code", cask: true };
    await expect(cache.homebrew(source)).resolves.toMatchObject({
      version: null,
      freshness: "unavailable",
      error: "Latest-version information is temporarily unavailable.",
    });
    now += 10 * 60_000;
    await expect(cache.homebrew(source)).resolves.toMatchObject({ version: null, freshness: "unavailable" });
  });

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
