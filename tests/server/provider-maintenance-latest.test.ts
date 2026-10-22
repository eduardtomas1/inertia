import { describe, expect, it, vi } from "vitest";

import {
  compareProviderVersions,
  PROVIDER_CLI_RELEASE_COOLDOWN_HOURS,
  PROVIDER_CLI_RELEASE_COOLDOWN_MS,
  ProviderLatestVersionCache,
  ProviderReleaseCooldownError,
  selectProviderRelease,
} from "../../src/server/provider/maintenance-latest";
import {
  npmPackument,
  npmPackumentResponse,
} from "../support/npm-registry-packument";

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
    let now = 1_000_000_000;
    const request = vi.fn(async () => npmPackumentResponse("2.3.4", { "2.3.4": {} }, now));
    const cache = new ProviderLatestVersionCache({
      fetch: request as typeof fetch,
      now: () => now,
      successTtlMs: 60_000,
    });

    const [first, concurrent] = await Promise.all([
      cache.latest("@openai/codex", "latest"),
      cache.latest("@openai/codex", "latest"),
    ]);
    now += 1_000;
    const cached = await cache.latest("@openai/codex", "latest");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "https://registry.npmjs.org/%40openai%2Fcodex",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(first).toMatchObject({ version: "2.3.4", heldVersion: null, freshness: "fresh" });
    expect(concurrent).toEqual(first);
    expect(cached).toEqual(first);
  });

  it("keeps the last known valid version stale after a transient failure", async () => {
    let now = 1_000_000_000;
    const request = vi.fn()
      .mockResolvedValueOnce(npmPackumentResponse("2.3.4", { "2.3.4": {} }, now))
      .mockRejectedValueOnce(new Error("offline"));
    const cache = new ProviderLatestVersionCache({
      fetch: request as typeof fetch,
      now: () => now,
      successTtlMs: 60_000,
      failureTtlMs: 10_000,
    });
    await cache.latest("@openai/codex", "latest");
    now += 61_000;

    const stale = await cache.latest("@openai/codex", "latest");

    expect(stale).toMatchObject({
      version: "2.3.4",
      freshness: "stale",
      error: "Latest-version information is temporarily unavailable.",
    });
  });

  it("rejects malformed and oversized registry payloads honestly", async () => {
    const huge = new Response(
      JSON.stringify(npmPackument({ latest: "1.0.0" }, { "1.0.0": {} })),
      { headers: { "content-length": String(65 * 1024 * 1024) } },
    );
    const responses = [
      new Response(JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } }), { status: 200 }),
      new Response(JSON.stringify({ "dist-tags": { latest: "not-a-version" }, versions: {}, time: {} }), { status: 200 }),
      new Response("not json", { status: 200 }),
      new Response("{}", { status: 404 }),
      huge,
    ];
    const request = vi.fn(async () => responses.shift()!);
    const cache = new ProviderLatestVersionCache({
      fetch: request as typeof fetch,
      failureTtlMs: 10_000,
    });

    for (const name of ["no-times", "bad-tag", "not-json", "missing", "oversized"]) {
      expect(await cache.latest(name, "latest", true)).toMatchObject({
        version: null,
        freshness: "unavailable",
        error: "Latest-version information is temporarily unavailable.",
      });
    }
  });

  it("reports a release that is not old enough as a cooldown, not as an outage", async () => {
    const now = 1_000_000_000;
    const cache = new ProviderLatestVersionCache({
      fetch: (async () => npmPackumentResponse("2.0.0", { "2.0.0": { hoursAgo: 1 } }, now)) as typeof fetch,
      now: () => now,
    });

    expect(await cache.latest("@openai/codex", "latest")).toMatchObject({
      version: null,
      freshness: "unavailable",
      error: `No release has been public for at least ${PROVIDER_CLI_RELEASE_COOLDOWN_HOURS} hours yet.`,
    });
  });

  it("measures the cooldown against the registry clock when the local clock runs ahead", async () => {
    const served = 1_000_000_000;
    const cache = new ProviderLatestVersionCache({
      fetch: (async () => {
        const body = JSON.stringify(npmPackument(
          { latest: "2.0.0" },
          { "1.0.0": {}, "2.0.0": { hoursAgo: 1 } },
          served,
        ));
        return new Response(body, { headers: { date: new Date(served).toUTCString() } });
      }) as typeof fetch,
      now: () => served + 30 * 24 * 3_600_000,
    });

    expect(await cache.latest("@openai/codex", "latest")).toMatchObject({
      version: "1.0.0",
      heldVersion: "2.0.0",
    });
  });
});

describe("selectProviderRelease", () => {
  const now = Date.UTC(2026, 9, 22);

  it("installs the dist-tag release once it has been public for the whole cooldown", () => {
    expect(PROVIDER_CLI_RELEASE_COOLDOWN_MS).toBe(72 * 3_600_000);
    expect(selectProviderRelease(
      npmPackument({ latest: "1.2.0" }, { "1.1.0": {}, "1.2.0": { hoursAgo: 72 } }, now),
      "latest",
      now,
    )).toEqual({ version: "1.2.0", heldVersion: null });
  });

  it("falls back to the newest older release while the dist-tag release is too new", () => {
    expect(selectProviderRelease(
      npmPackument({ latest: "1.2.0" }, {
        "1.0.0": { hoursAgo: 500 },
        "1.1.0": { hoursAgo: 100 },
        "1.1.1": { hoursAgo: 71 },
        "1.2.0": { hoursAgo: 2 },
      }, now),
      "latest",
      now,
    )).toEqual({ version: "1.1.0", heldVersion: "1.2.0" });
  });

  it("never looks past the dist-tag release, even at old untagged versions", () => {
    expect(selectProviderRelease(
      npmPackument({ latest: "1.2.0" }, { "1.2.0": {}, "1.3.0": {}, "2.0.0": {} }, now),
      "latest",
      now,
    ).version).toBe("1.2.0");
  });

  it("chooses the highest release in a major range that is old enough", () => {
    expect(selectProviderRelease(
      npmPackument({ latest: "2.1.0" }, {
        "1.9.0": {},
        "1.10.0": {},
        "1.10.1": { hoursAgo: 5 },
        "2.1.0": {},
      }, now),
      "1",
      now,
    )).toEqual({ version: "1.10.0", heldVersion: "1.10.1" });
  });

  it("skips prereleases unless the dist-tag itself is a prerelease", () => {
    const packument = npmPackument({ latest: "1.1.0", next: "1.2.0-beta.2" }, {
      "1.0.0": {},
      "1.1.0-alpha.1": {},
      "1.1.0": { hoursAgo: 1 },
      "1.2.0-beta.1": {},
      "1.2.0-beta.2": { hoursAgo: 1 },
    }, now);
    expect(selectProviderRelease(packument, "latest", now).version).toBe("1.0.0");
    expect(selectProviderRelease(packument, "1", now).version).toBe("1.0.0");
    expect(selectProviderRelease(packument, "next", now)).toEqual({
      version: "1.2.0-beta.1",
      heldVersion: "1.2.0-beta.2",
    });
  });

  it("never chooses a deprecated release", () => {
    expect(selectProviderRelease(
      npmPackument({ latest: "1.2.0" }, {
        "1.0.0": { deprecated: "" },
        "1.1.0": {},
        "1.2.0": { deprecated: "Compromised publish, use 1.1.0" },
      }, now),
      "latest",
      now,
    )).toEqual({ version: "1.1.0", heldVersion: null });
  });

  it("fails safe when every matching release is too new or deprecated", () => {
    expect(() => selectProviderRelease(
      npmPackument({ latest: "1.2.0" }, {
        "1.1.0": { deprecated: "broken" },
        "1.2.0": { hoursAgo: 12 },
      }, now),
      "latest",
      now,
    )).toThrow(ProviderReleaseCooldownError);
  });

  it("ignores releases with a missing or unreadable publish time", () => {
    const packument = npmPackument({ latest: "1.1.0" }, { "1.0.0": {}, "1.1.0": {} }, now);
    (packument.time as Record<string, unknown>)["1.1.0"] = "yesterday-ish";
    expect(selectProviderRelease(packument, "latest", now).version).toBe("1.0.0");
  });

  it("refuses unknown tags and specs it cannot evaluate", () => {
    const packument = npmPackument({ latest: "1.0.0" }, { "1.0.0": {} }, now);
    expect(() => selectProviderRelease(packument, "canary", now)).toThrow("package spec");
    expect(() => selectProviderRelease(packument, "^1.0.0", now)).toThrow("package spec");
    expect(() => selectProviderRelease({ versions: {} }, "latest", now)).toThrow("release times");
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
