import { afterEach, describe, expect, it, vi } from "vitest";
import { appUpdateReleaseNotes, condensedReleaseNote } from "../../src/main/app-update-release-notes";
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

function release(tag_name: string, body: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag_name, body, draft: false, prerelease: false, html_url: "https://untrusted.invalid", ...extra };
}
function behind(fetch: typeof globalThis.fetch, { installed = "1.2.0", latest = "1.2.5", channel = "stable" as "stable" | "canary" } = {}): AppUpdateService {
  const updater: AppUpdaterAdapter = { check: async () => ({ available: true, version: latest, releaseNotes: "Newest notes" }),
    download: vi.fn(), quitAndInstall: vi.fn() };
  return new AppUpdateService({ currentVersion: installed, fetch, capability: { delivery: "in-app" },
    loadUpdater: async () => updater, channel, timeoutMs: 1_000 });
}
const page = (version: string) => `https://github.com/eduardtomas1/inertia/releases/tag/v${version}`;
describe("condensed notes for older skipped releases", () => {
  it("keeps the opening summary sentence and counts the changes behind it", () => {
    expect(condensedReleaseNote("Any agent as a watcher, and\n**API keys** beside accounts.\n\n### Watcher\n\n- One\n- Two\n  - Nested\n1. Three"))
      .toEqual({ notes: "Any agent as a watcher, and **API keys** beside accounts.", omittedItems: 3 });
  });
  it("shows the first three bullets of a release without a summary", () => {
    expect(condensedReleaseNote("### Chats\n\n- One\n  continued\n- Two\n\n### Tasks\n\n* Three\n2) Four\n- Five"))
      .toEqual({ notes: "- One\n- Two\n- Three", omittedItems: 2 });
    expect(condensedReleaseNote("- Only fix")).toEqual({ notes: "- Only fix", omittedItems: 0 });
  });
  it("clips long text at a word boundary", () => {
    const summary = condensedReleaseNote(`${"word ".repeat(80)}end`);
    expect(summary.notes.length).toBeLessThanOrEqual(280);
    expect(summary.notes).toMatch(/word…$/u);
    expect(condensedReleaseNote(`- ${"x".repeat(400)}`).notes).toBe(`- ${"x".repeat(219)}…`);
    expect(condensedReleaseNote("### Heading only\n\n> quoted")).toEqual({ notes: "Heading only quoted", omittedItems: 0 });
  });
});
describe("releases skipped between the installed and newest version", () => {
  it("lists every published release in between, newest first, with main-authored release pages", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify([
      release("v1.2.5", "Newest from list"),
      release("v1.2.3", "Draft", { draft: true }),
      release("canary-v1.2.4", "Canary", { prerelease: true }),
      release("v1.2.2", "  "),
      release("v1.2.1", "- First fix\u202e\n- Second fix"),
      release("v1.2.4", "Fourth release summary.\n\n- A\n- B"),
      release("v1.2.4", "Duplicate"),
      release("v1.2.0", "Installed"),
      release("v1.1.9", "Older"),
      release("v1.2.x", "Malformed"),
      "not a release",
    ])));
    const status = await behind(fetch).check();
    expect(status).toMatchObject({ latestVersion: "1.2.5", releaseNotes: "Newest notes", releaseHistoryOmitted: 0,
      releasesUrl: "https://github.com/eduardtomas1/inertia/releases", releaseHistory: [
        { version: "1.2.4", notes: "Fourth release summary.", omittedItems: 2, releaseUrl: page("1.2.4") },
        { version: "1.2.1", notes: "- First fix\n- Second fix", omittedItems: 0, releaseUrl: page("1.2.1") },
      ] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/eduardtomas1/inertia/releases?per_page=20",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });
  it("shows at most five older releases and counts the rest", async () => {
    const list = Array.from({ length: 9 }, (_, index) => release(`v1.2.${index + 1}`, `Notes ${index + 1}`));
    const status = await behind(async () => new Response(JSON.stringify(list)), { latest: "1.2.10" }).check();
    expect(status.releaseHistory?.map(({ version }) => version)).toEqual(["1.2.9", "1.2.8", "1.2.7", "1.2.6", "1.2.5"]);
    expect(status.releaseHistoryOmitted).toBe(4);
  });
  it("reads canary releases only from canary prereleases", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify([
      release("v1.2.3", "Stable"), release("canary-v1.2.3", "Canary three", { prerelease: true }),
      release("canary-v1.2.2", "Not marked prerelease"),
    ])));
    expect((await behind(fetch, { channel: "canary" }).check()).releaseHistory).toEqual([
      { version: "1.2.3", notes: "Canary three", omittedItems: 0, releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/canary-v1.2.3" },
    ]);
  });
  it("does not ask for the list when the newest release is the next patch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await behind(fetch, { installed: "1.2.4" }).check()).toMatchObject({ state: "available", releaseHistory: [], releaseHistoryOmitted: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    () => new Response("unavailable", { status: 503 }),
    () => new Response(JSON.stringify({ message: "rate limited" })),
    () => new Response(JSON.stringify([release("v1.2.4", "x")]), { headers: { "content-length": String(3 * 1_024 * 1_024) } }),
  ])("keeps the update usable when the list cannot be read: %#", async (response) => {
    expect(await behind(async () => response()).check()).toMatchObject({ state: "available", latestVersion: "1.2.5",
      releaseNotes: "Newest notes", releaseHistory: [], releaseHistoryOmitted: 0 });
  });
  it("accepts a release list larger than a single release response", async () => {
    const list = [release("v1.2.4", "Fourth"), ...Array.from({ length: 19 }, () => release("v1.1.0", "x".repeat(90_000)))];
    expect((await behind(async () => new Response(JSON.stringify(list))).check()).releaseHistory?.map(({ version }) => version)).toEqual(["1.2.4"]);
  });
  it("keeps the history when a later check falls back to the cached result", async () => {
    let offline = false;
    const service = new AppUpdateService({ currentVersion: "1.2.0", fetch: async (input) => {
      if (offline) throw new Error("offline");
      return new Response(JSON.stringify(String(input).includes("per_page")
        ? [release("v1.2.3", "Third")] : { tag_name: "v1.2.5", body: "Newest" }));
    } });
    expect(await service.check()).toMatchObject({ freshness: "fresh", releaseHistory: [{ version: "1.2.3", notes: "Third" }] });
    offline = true;
    expect(await service.check(true)).toMatchObject({ freshness: "cached", latestVersion: "1.2.5",
      releaseHistory: [{ version: "1.2.3", notes: "Third" }], releaseHistoryOmitted: 0 });
  });
});
