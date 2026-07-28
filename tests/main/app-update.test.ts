import { describe, expect, it, vi } from "vitest";

import {
  AppUpdateService,
  compareAppVersions,
} from "../../src/main/app-update";

function release(tagName: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({
    tag_name: tagName,
    html_url: "https://attacker.invalid/not-used",
    body: "Release content is intentionally ignored.",
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("app update checks", () => {
  it("compares only strict stable semantic versions", () => {
    expect(compareAppVersions("0.0.10", "0.0.9")).toBe(1);
    expect(compareAppVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareAppVersions("1.2.3", "2.0.0")).toBe(-1);
    expect(() => compareAppVersions("1.2.3-beta", "1.2.3")).toThrow(
      "major.minor.patch",
    );
    expect(() => compareAppVersions("01.2.3", "1.2.3")).toThrow(
      "major.minor.patch",
    );
  });

  it("reports a newer public release without trusting remote URLs or content", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Inertia/0.0.10",
        },
      });
      return release("v0.0.11");
    });
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch,
      now: () => Date.parse("2030-01-02T03:04:05.000Z"),
    });

    await expect(service.check()).resolves.toEqual({
      state: "available",
      freshness: "fresh",
      currentVersion: "0.0.10",
      latestVersion: "0.0.11",
      releaseUrl:
        "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.11",
      checkedAt: "2030-01-02T03:04:05.000Z",
      lastAttemptedAt: "2030-01-02T03:04:05.000Z",
      message: "Inertia 0.0.11 is available.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces requests, caches success, and lets an explicit refresh bypass the cache", async () => {
    let settle!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => release("v0.0.10"));
    let now = Date.parse("2030-01-02T03:04:05.000Z");
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch,
      now: () => now,
    });

    const left = service.check();
    const right = service.check();
    expect(fetch).toHaveBeenCalledTimes(1);
    settle(release("v0.0.10"));
    await expect(Promise.all([left, right])).resolves.toHaveLength(2);

    now += 1_000;
    await expect(service.check()).resolves.toMatchObject({
      state: "current",
      freshness: "cached",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(service.check(true)).resolves.toMatchObject({
      state: "current",
      freshness: "fresh",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the last valid result on a transient failure and reports an honest empty state", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(release("v0.0.11"))
      .mockRejectedValueOnce(new Error("offline"));
    let now = Date.parse("2030-01-02T03:04:05.000Z");
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch,
      now: () => now,
    });
    await service.check();
    now += 1_000;
    await expect(service.check(true)).resolves.toMatchObject({
      state: "available",
      freshness: "cached",
      latestVersion: "0.0.11",
      message:
        "Inertia 0.0.11 is available. The latest check could not be completed.",
    });

    const unavailable = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        release("v0.0.11", { "Content-Length": String(65 * 1_024) })),
      now: () => now,
    });
    await expect(unavailable.check()).resolves.toMatchObject({
      state: "unavailable",
      freshness: "unavailable",
      latestVersion: null,
      checkedAt: null,
    });
  });

  it("rejects malformed, prerelease, and oversized response bodies", async () => {
    for (const response of [
      release("v0.0.11-beta"),
      new Response(JSON.stringify({ tag_name: 11 })),
      new Response("x".repeat(65 * 1_024)),
    ]) {
      const service = new AppUpdateService({
        currentVersion: "0.0.10",
        fetch: vi.fn<typeof globalThis.fetch>(async () => response),
      });
      await expect(service.check()).resolves.toMatchObject({
        state: "unavailable",
        latestVersion: null,
      });
    }
  });
});
