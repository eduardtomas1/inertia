import { afterEach, describe, expect, it, vi } from "vitest";
import { appUpdateReleaseNotes } from "../../src/main/app-update-release-notes";
import { AppUpdateService } from "../../src/main/app-update";
import type { AppUpdaterAdapter } from "../../src/main/electron-app-updater";

afterEach(() => vi.useRealTimers());
function native(fetch: typeof globalThis.fetch, releaseNotes?: unknown, channel: "stable" | "canary" = "stable"): AppUpdateService {
  const updater: AppUpdaterAdapter = { check: async () => ({ available: true, version: "1.2.3", releaseNotes }),
    download: vi.fn(), quitAndInstall: vi.fn() };
  return new AppUpdateService({ currentVersion: "1.2.2", fetch, capability: { delivery: "in-app" },
    loadUpdater: async () => updater, channel, timeoutMs: 1_000 });
}
describe("exact-candidate release notes", () => {
  it("bounds text, strips control/bidi characters and ignores malformed notes", () => {
    expect(appUpdateReleaseNotes(" \u0000hello\nworld\u202e ", "1.2.3")).toBe("hello\nworld");
    expect(appUpdateReleaseNotes("x".repeat(20_000), "1.2.3")).toBe("x".repeat(8192) + "\n…");
    for (const value of [null, undefined, 42, { note: false }, { version: "1.2.4", note: "Wrong release" }, [], "  "]) expect(appUpdateReleaseNotes(value, "1.2.3")).toBeNull();
    expect(appUpdateReleaseNotes([{ version: "1.2.4", note: "wrong" }, { version: "1.2.3", note: "correct" }], "1.2.3")).toBe("correct");
    expect(appUpdateReleaseNotes(Array.from({ length: 33 }, (_, i) => ({ version: i === 32 ? "1.2.3" : "0.0.0", note: "out of bounds" })), "1.2.3")).toBeNull();
  });
  it("reuses bounded native notes without another request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = native(fetch, [{ version: "1.2.3", note: "New controls" }]);
    expect(await service.check()).toMatchObject({ latestVersion: "1.2.3", releaseNotes: "New controls" });
    await service.check();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["stable", "canary"] as const)("fetches only the exact %s tag when generic update metadata omits notes", async (channel) => {
    const tag = channel === "canary" ? "canary-v1.2.3" : "v1.2.3";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ tag_name: tag,
      body: "Release improvements", html_url: "https://untrusted.invalid" })));
    const service = native(fetch, undefined, channel);
    expect(await service.check()).toMatchObject({ state: "available", releaseNotes: "Release improvements",
      releaseUrl: `https://github.com/eduardtomas1/inertia/releases/tag/${tag}` });
    expect(fetch).toHaveBeenCalledWith(`https://api.github.com/repos/eduardtomas1/inertia/releases/tags/${tag}`,
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
    await service.check(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { tag_name: "v1.2.4", body: "Different release" },
    { tag_name: "v1.2.3", body: { html: "Not text" } },
    { tag_name: "v1.2.3", body: "x".repeat(70_000) },
  ])("keeps the native candidate usable when notes are invalid: %#", async (metadata) => {
    const service = native(async () => new Response(JSON.stringify(metadata)));
    expect(await service.check()).toMatchObject({ state: "available", latestVersion: "1.2.3", releaseNotes: null });
  });
  it("treats a notes timeout as optional, and clears its deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("offline")), { once: true });
    }));
    const service = native(fetch);
    const result = service.check();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result).toMatchObject({ state: "available", releaseNotes: null });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains exact-version notes in the cached status when a subsequent check fails", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ tag_name: "v1.2.3", body: "Cached notes" })))
      .mockRejectedValueOnce(new Error("offline"));
    const service = new AppUpdateService({ currentVersion: "1.2.2", fetch });
    await service.check();
    expect(await service.check(true)).toMatchObject({ freshness: "cached", latestVersion: "1.2.3", releaseNotes: "Cached notes" });
  });
});
