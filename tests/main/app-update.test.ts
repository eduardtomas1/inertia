import { describe, expect, it, vi } from "vitest";

import {
  AppUpdateService,
  compareAppVersions,
} from "../../src/main/app-update";
import type {
  AppUpdaterAdapter,
  AppUpdaterDownload,
  AppUpdaterDownloadProgress,
} from "../../src/main/electron-app-updater";

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
      revision: 2,
      channel: "stable",
      state: "available",
      freshness: "fresh",
      delivery: "manual",
      deliveryReason: "development-build",
      installBlocker: null,
      progress: null,
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

  it("checks only the isolated Canary feed and reports its immutable release tag", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(String(input)).toBe(
        "https://raw.githubusercontent.com/eduardtomas1/inertia/canary-feed/canary-status.json",
      );
      return new Response(JSON.stringify({
        version: "0.0.12",
        tag: "canary-v0.0.12",
        remoteUrl: "https://attacker.invalid/ignored",
      }));
    });
    const service = new AppUpdateService({
      currentVersion: "0.0.11",
      channel: "canary",
      fetch,
    });

    await expect(service.check()).resolves.toMatchObject({
      channel: "canary",
      state: "available",
      latestVersion: "0.0.12",
      releaseUrl:
        "https://github.com/eduardtomas1/inertia/releases/tag/canary-v0.0.12",
      message: "Inertia Canary 0.0.12 is available.",
    });
  });

  it("downloads explicitly, publishes bounded progress, and blocks installation safely", async () => {
    let finishDownload!: () => void;
    let progress!: (value: AppUpdaterDownloadProgress) => void;
    const quitAndInstall = vi.fn(async () => true);
    const updater: AppUpdaterAdapter = {
      check: vi.fn(async () => ({ available: true, version: "0.0.11" })),
      download: vi.fn((callbacks): AppUpdaterDownload => {
        progress = callbacks.onProgress;
        return {
          promise: new Promise<void>((resolve) => {
            finishDownload = resolve;
          }),
          cancel: vi.fn(),
        };
      }),
      quitAndInstall,
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const statuses: Array<ReturnType<AppUpdateService["current"]>> = [];
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch,
      capability: { delivery: "in-app" },
      loadUpdater: async () => updater,
    });
    service.subscribe((status) => statuses.push(status));

    await expect(service.check()).resolves.toMatchObject({
      state: "available",
      delivery: "in-app",
      latestVersion: "0.0.11",
    });
    expect(fetch).not.toHaveBeenCalled();

    const downloading = service.download();
    await vi.waitFor(() => expect(updater.download).toHaveBeenCalledTimes(1));
    progress({ percent: 125, transferred: 250, total: 200, bytesPerSecond: 12.9 });
    expect(service.current()).toMatchObject({
      state: "downloading",
      progress: {
        percent: 100,
        transferredBytes: 200,
        totalBytes: 200,
        bytesPerSecond: 12,
      },
    });
    finishDownload();
    await expect(downloading).resolves.toMatchObject({ state: "downloaded" });

    expect(service.beginInstall()).toMatchObject({ state: "installing" });
    expect(service.blockInstall("terminal")).toMatchObject({
      state: "downloaded",
      installBlocker: "terminal",
    });
    service.beginInstall();
    await service.quitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    expect(statuses.every((status, index) => index === 0 || status.revision > statuses[index - 1]!.revision)).toBe(true);
  });

  it("scopes cancellation to the active download and permits an explicit retry", async () => {
    let cancel!: () => void;
    let settle!: () => void;
    const updater: AppUpdaterAdapter = {
      check: vi.fn(async () => ({ available: true, version: "0.0.11" })),
      download: vi.fn((callbacks): AppUpdaterDownload => {
        let cancelled = false;
        cancel = () => {
          cancelled = true;
          callbacks.onCancelled();
          settle();
        };
        return {
          promise: new Promise<void>((resolve, reject) => {
            settle = () => cancelled
              ? reject(new Error("cancelled"))
              : resolve();
          }),
          cancel,
        };
      }),
      quitAndInstall: vi.fn(async () => true),
    };
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch: vi.fn<typeof globalThis.fetch>(),
      capability: { delivery: "in-app" },
      loadUpdater: async () => updater,
    });
    await service.check();
    const first = service.download();
    await vi.waitFor(() => expect(updater.download).toHaveBeenCalledTimes(1));
    expect(service.cancelDownload()).toMatchObject({ state: "cancelled" });
    await expect(first).resolves.toMatchObject({ state: "cancelled" });

    const second = service.download();
    await vi.waitFor(() => expect(updater.download).toHaveBeenCalledTimes(2));
    settle();
    await expect(second).resolves.toMatchObject({ state: "downloaded" });
    cancel();
    expect(service.current().state).toBe("downloaded");
  });

  it("does not start a cancelled native download and queues an immediate retry", async () => {
    let settleRetry!: () => void;
    const updater: AppUpdaterAdapter = {
      check: vi.fn(async () => ({ available: true, version: "0.0.11" })),
      download: vi.fn(() => ({
        promise: new Promise<void>((resolve) => { settleRetry = resolve; }),
        cancel: vi.fn(),
      })),
      quitAndInstall: vi.fn(async () => true),
    };
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch: vi.fn<typeof globalThis.fetch>(),
      capability: { delivery: "in-app" },
      loadUpdater: async () => updater,
    });
    await service.check();

    const cancelled = service.download();
    service.cancelDownload();
    const retry = service.download();
    await expect(cancelled).resolves.toMatchObject({ state: "cancelled" });
    await vi.waitFor(() => expect(updater.download).toHaveBeenCalledTimes(1));
    settleRetry();
    await expect(retry).resolves.toMatchObject({ state: "downloaded" });
  });

  it("honors a native platform or staged-rollout exclusion", async () => {
    const updater: AppUpdaterAdapter = {
      check: vi.fn(async () => ({ available: false, version: "0.0.11" })),
      download: vi.fn(),
      quitAndInstall: vi.fn(async () => true),
    };
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch: vi.fn<typeof globalThis.fetch>(),
      capability: { delivery: "in-app" },
      loadUpdater: async () => updater,
    });

    await expect(service.check()).resolves.toMatchObject({
      state: "current",
      latestVersion: "0.0.11",
    });
    await expect(service.download()).rejects.toThrow("No checked update");
  });

  it("retries a rejected updater initialization without duplicating a success", async () => {
    const updater: AppUpdaterAdapter = {
      check: vi.fn(async () => ({ available: true, version: "0.0.11" })),
      download: vi.fn(),
      quitAndInstall: vi.fn(async () => true),
    };
    const loadUpdater = vi.fn<() => Promise<AppUpdaterAdapter>>()
      .mockRejectedValueOnce(new Error("dynamic import failed once"))
      .mockResolvedValue(updater);
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch: vi.fn<typeof globalThis.fetch>(),
      capability: { delivery: "in-app" },
      loadUpdater,
    });

    await expect(service.check()).resolves.toMatchObject({
      state: "unavailable",
    });
    await expect(Promise.all([service.check(), service.check()])).resolves
      .toEqual([
        expect.objectContaining({ state: "available" }),
        expect.objectContaining({ state: "available" }),
      ]);
    await expect(service.check(true)).resolves.toMatchObject({
      state: "available",
    });
    expect(loadUpdater).toHaveBeenCalledTimes(2);
    expect(updater.check).toHaveBeenCalledTimes(2);
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

  it("cancels a chunked manual response as soon as the byte limit is crossed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1_024));
        controller.enqueue(new Uint8Array(40 * 1_024));
      },
      cancel() { cancelled = true; },
    });
    const service = new AppUpdateService({
      currentVersion: "0.0.10",
      fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(body)),
    });

    await expect(service.check()).resolves.toMatchObject({ state: "unavailable" });
    expect(cancelled).toBe(true);
  });
});
